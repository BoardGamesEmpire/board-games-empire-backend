import { AbilityService } from '@bge/permissions';
import { ForbiddenException } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { AbilityAwareWorkerHost } from './ability-aware.worker-host';

interface TestJobData {
  foo: string;
}

/**
 * Concrete subclass that satisfies the abstract `processJob` and exposes the
 * protected `onScopeReady` hook for assertion.
 */
class TestProcessor extends AbilityAwareWorkerHost<TestJobData> {
  protected processJob(): Promise<unknown> {
    return Promise.resolve('done');
  }

  triggerOnScopeReady(job: Job<TestJobData>): Promise<void> {
    return this.onScopeReady(job);
  }
}

describe('AbilityAwareWorkerHost', () => {
  let processor: TestProcessor;
  let abilityService: jest.Mocked<Pick<AbilityService, 'primeCurrentActor'>>;

  beforeEach(() => {
    abilityService = { primeCurrentActor: jest.fn().mockResolvedValue(undefined) };

    processor = new TestProcessor();
    // The host injects AbilityService as a property; set it directly for the unit test.
    (processor as unknown as { abilityService: typeof abilityService }).abilityService = abilityService;
  });

  afterEach(() => jest.clearAllMocks());

  it('primes the current actor when the scope is ready', async () => {
    await processor.triggerOnScopeReady({} as Job<TestJobData>);

    expect(abilityService.primeCurrentActor).toHaveBeenCalledTimes(1);
  });

  it('propagates a transient priming failure unchanged so BullMQ retries', async () => {
    const error = new Error('database unreachable');
    abilityService.primeCurrentActor.mockRejectedValue(error);

    await expect(processor.triggerOnScopeReady({} as Job<TestJobData>)).rejects.toThrow(error);
  });

  it('rethrows a resolution ForbiddenException as UnrecoverableError — permanent refusal, never retried', async () => {
    // A resolution-time 403 means the actor's authority is structurally gone
    // (revoked key, unrenderable plugin grant); retrying re-fails forever.
    abilityService.primeCurrentActor.mockRejectedValue(new ForbiddenException('grant cannot render'));

    await expect(processor.triggerOnScopeReady({} as Job<TestJobData>)).rejects.toThrow(UnrecoverableError);
    await expect(processor.triggerOnScopeReady({} as Job<TestJobData>)).rejects.toThrow(/grant cannot render/);
  });
});
