import { Test, type TestingModule } from '@nestjs/testing';
import type { Job } from 'bullmq';
import { ClsModule, ClsService } from 'nestjs-cls';
import { ActorAwareWorkerHost } from './actor-aware.worker-host';
import { type JobActorMeta, wrapJobData } from './job-meta';
import { AuditContextInternalService } from './services/audit-context-internal.service';
import { AuditContextService } from './services/audit-context.service';
import type { Actor } from './types';

interface SampleJobData {
  readonly gameId: string;
}

interface CapturedContext {
  readonly actor: Actor | null;
  readonly correlationId: string | null;
  readonly source: string | null;
}

class SampleWorker extends ActorAwareWorkerHost<SampleJobData, CapturedContext> {
  constructor(
    auditContext: AuditContextInternalService,
    private readonly context: AuditContextService,
  ) {
    super(auditContext);
  }

  protected async processJob(): Promise<CapturedContext> {
    return {
      actor: this.context.getActor(),
      correlationId: this.context.getCorrelationId(),
      source: this.context.getSource(),
    };
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
      providers: [
        AuditContextService,
        AuditContextInternalService,
        {
          provide: SampleWorker,
          useFactory: (internal: AuditContextInternalService, context: AuditContextService) =>
            new SampleWorker(internal, context),
          inject: [AuditContextInternalService, AuditContextService],
        },
      ],
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
      constructor(internal: AuditContextInternalService) {
        super(internal);
      }
      protected async processJob(): Promise<never> {
        throw new Error('boom');
      }
    }

    const internal = module.get(AuditContextInternalService);
    const failing = new FailingWorker(internal);
    const job = buildJob(wrapJobData({ gameId: 'g1' }, { actor: { kind: 'system', reason: 't' }, correlationId: 'c' }));

    await expect(failing.process(job)).rejects.toThrow('boom');
  });
});
