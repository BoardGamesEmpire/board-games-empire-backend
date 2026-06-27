import type { Actor } from '@bge/actor-context';
import { AuditContextInternalService, AuditContextService } from '@bge/actor-context';
import { Injectable } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { ClsModule, ClsService } from 'nestjs-cls';
import { ActorAwareWorkerHost } from './actor-aware.worker-host';
import { type JobActorMeta, wrapJobData } from './job-meta';

interface SampleJobData {
  readonly gameId: string;
}

interface CapturedContext {
  readonly actor: Actor | null;
  readonly correlationId: string | null;
  readonly source: string | null;
}

@Injectable()
class SampleWorker extends ActorAwareWorkerHost<SampleJobData, CapturedContext> {
  constructor(private readonly context: AuditContextService) {
    super();
  }

  protected async processJob(): Promise<CapturedContext> {
    return {
      actor: this.context.getActor(),
      correlationId: this.context.getCorrelationId(),
      source: this.context.getSource(),
    } satisfies CapturedContext;
  }
}

function buildJob<T>(data: T, overrides: Partial<Pick<Job, 'id' | 'queueName'>> = {}): Job<T, CapturedContext> {
  return {
    id: overrides.id ?? 'job-1',
    queueName: overrides.queueName ?? 'sample-queue',
    data,
  } as unknown as Job<T, CapturedContext>;
}

describe('ActorAwareWorkerHost', () => {
  let module: TestingModule;
  let worker: SampleWorker;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    module = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } })],
      // SampleWorker is registered as a plain class provider so Nest performs
      // the real constructor injection (AuditContextService) *and* the base
      // class's property injection (AuditContextInternalService) — exercising
      // the wiring the production processors rely on.
      providers: [AuditContextService, AuditContextInternalService, SampleWorker],
    }).compile();

    worker = module.get(SampleWorker);
    warnSpy = jest.spyOn(module.get(ClsService), 'isActive');
    warnSpy.mockClear();
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await module.close();
  });

  it('populates CLS from a wrapped job payload', async () => {
    const actor: Actor = {
      kind: 'apiKey',
      apiKeyId: 'key-1',
      userId: 'user-1',
    };
    const meta: JobActorMeta = { actor, correlationId: 'corr-job-1' };

    const job = buildJob(wrapJobData({ gameId: 'g1' }, meta));
    const captured = await worker.process(job);

    expect(captured).toEqual({
      actor,
      correlationId: 'corr-job-1',
      source: 'queue',
    });
  });

  it('produces independent CLS scopes per job invocation', async () => {
    const actorA: Actor = { kind: 'user', userId: 'user-A' };
    const actorB: Actor = { kind: 'user', userId: 'user-B' };

    const jobA = buildJob(wrapJobData({ gameId: 'g1' }, { actor: actorA, correlationId: 'a' }));
    const jobB = buildJob(wrapJobData({ gameId: 'g2' }, { actor: actorB, correlationId: 'b' }));

    const [a, b] = await Promise.all([worker.process(jobA), worker.process(jobB)]);

    expect(a.actor).toEqual(actorA);
    expect(b.actor).toEqual(actorB);
    expect(a.correlationId).toBe('a');
    expect(b.correlationId).toBe('b');
  });

  it('propagates errors from processJob through the CLS scope', async () => {
    class FailingWorker extends ActorAwareWorkerHost<SampleJobData> {
      protected async processJob(): Promise<never> {
        throw new Error('boom');
      }
    }

    const internal = module.get(AuditContextInternalService);
    const failing = new FailingWorker();
    (failing as unknown as { auditContext: AuditContextInternalService }).auditContext = internal;
    const job = buildJob(wrapJobData({ gameId: 'g1' }, { actor: { kind: 'system', reason: 't' }, correlationId: 'c' }));

    await expect(failing.process(job)).rejects.toThrow('boom');
  });

  it('runInActorScope still runs the callback when the envelope is absent', async () => {
    // The motivating case: a job that failed *because* it was enqueued without
    // wrapJobData is handed back to a lifecycle hook (onFailed). The hook must
    // still run rather than re-throw the missing-envelope error.
    const unwrapped = buildJob({ gameId: 'g1' }); // deliberately NOT wrapped
    const ran = await (
      worker as unknown as {
        runInActorScope: (job: Job<SampleJobData>, fn: () => Promise<string>) => Promise<string>;
      }
    ).runInActorScope(unwrapped, async () => 'ran');

    expect(ran).toBe('ran');
  });

  it('runs onScopeReady before processJob inside the actor scope', async () => {
    class OrderTrackingProcessor extends ActorAwareWorkerHost<{ x: number }> {
      readonly calls: string[] = [];
      protected override async onScopeReady(): Promise<void> {
        this.calls.push('onScopeReady');
      }

      protected async processJob(): Promise<unknown> {
        this.calls.push('processJob');
        return 'ok';
      }
    }

    const processor = new OrderTrackingProcessor();
    const auditContext = { runWith: jest.fn((_init: unknown, fn: () => unknown) => fn()) };
    (processor as unknown as { auditContext: typeof auditContext }).auditContext = auditContext;

    const job = {
      data: wrapJobData({ x: 1 }, { actor: { kind: 'system', reason: 'test' }, correlationId: 'corr-1' }),
      queueName: 'q',
      id: '1',
    } as unknown as Job<{ x: number }>;

    await processor.process(job);

    expect(processor.calls).toEqual(['onScopeReady', 'processJob']);
  });
});
