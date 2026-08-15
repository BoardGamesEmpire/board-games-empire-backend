import { actorHasValidPluginUnits, AuditContextInternalService } from '@bge/actor-context';
import { WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { extractJobMeta } from './job-meta';

/**
 * Base class for BullMQ processors that participate in the actor/audit system.
 *
 * Subclasses override {@link processJob} instead of `process`. The base method
 * extracts the meta envelope, opens a CLS scope populated with actor +
 * correlation, and invokes the subclass.
 *
 * Jobs must be enqueued via `wrapJobData(payload, meta)` so the `__meta`
 * envelope is present. Jobs lacking the envelope are rejected — there is no
 * fallback actor. Producers are responsible for supplying actor context.
 *
 * @example
 *   @Processor(QUEUE_NAMES.GAME_IMPORT)
 *   export class GameImportProcessor extends ActorAwareWorkerHost<GameImportJobData> {
 *     protected processJob(job: Job<GameImportJobData & JobMetaEnvelope>) {
 *       // CLS is populated; emit events normally.
 *     }
 *   }
 */
export abstract class ActorAwareWorkerHost<TData, TResult = unknown, TName extends string = string> extends WorkerHost {
  // Injected as a property rather than through the constructor so subclasses
  // never have to import the eslint-restricted AuditContextInternalService just
  // to forward it through `super()`. That keeps the restricted-import exception
  // confined to this single base lib. Nest resolves `@Inject` properties
  // declared on a base class against the concrete subclass provider.
  @Inject(AuditContextInternalService)
  private readonly auditContext!: AuditContextInternalService;

  async process(job: Job<TData, TResult, TName>, token?: string): Promise<TResult> {
    // Both rejections are UnrecoverableError: job data is immutable, so an
    // absent envelope or a malformed actor can never heal — retrying
    // re-fails forever. The two messages stay distinct so the operator
    // chases the actual defect (a producer skipping wrapJobData vs. a
    // broken actor inside the envelope).
    const meta = extractJobMeta(job.data);

    if (!meta) {
      throw new UnrecoverableError(
        `Job ${job.queueName}#${job.id} missing __meta envelope; jobs must be enqueued via wrapJobData`,
      );
    }

    if (!actorHasValidPluginUnits(meta.actor)) {
      throw new UnrecoverableError(
        `Job ${job.queueName}#${job.id} envelope actor is malformed: a plugin actor carries an invalid ` +
          'consent unit somewhere in the trigger chain, or the chain does not terminate in a real ' +
          'non-plugin actor; the envelope is immutable, not retrying',
      );
    }

    return this.runInActorScope(job, async () => {
      await this.onScopeReady(job, token);
      return this.processJob(job, token);
    });
  }

  /**
   * Hook invoked inside the actor scope, immediately before {@link processJob}.
   * No-op by default; subclasses needing extra per-job CLS state override it
   * (e.g. `AbilityAwareWorkerHost`, which primes abilities). Kept off the lenient
   * `runInActorScope` path so `@OnWorkerEvent` failure handlers are unaffected.
   */
  protected async onScopeReady(_job: Job<TData, TResult, TName>, _token?: string): Promise<void> {
    // no-op
  }

  /**
   * Runs `fn` inside the CLS scope reconstructed from the job's actor envelope.
   * Use from `@OnWorkerEvent` lifecycle hooks (e.g. `onFailed`) so work outside
   * the main `process` path — DB writes, emitted events — is still attributed to
   * the originating actor and correlation.
   *
   * Lenient by design: a job missing the envelope runs `fn` without a scope
   * rather than throwing — a failure handler must not mask the original error.
   * The strict envelope requirement is enforced in {@link process}.
   */
  protected runInActorScope<T>(job: Job<TData, TResult, TName>, fn: () => T): T {
    const meta = extractJobMeta(job.data);

    // Lenient on invalid plugin units for the same reason as a missing
    // envelope: a failure handler must not mask the original error, and
    // installing an actor with a malformed unit would blow up downstream
    // (projection, ability resolution) instead. Attribution is dropped; the
    // strict rejection lives in `process`.
    if (!meta || !actorHasValidPluginUnits(meta.actor)) {
      return fn();
    }

    return this.auditContext.runWith(
      {
        actor: meta.actor,
        correlationId: meta.correlationId,
        source: 'queue',
      },
      fn,
    );
  }

  /**
   * Subclass entry point. CLS is populated when this is invoked.
   */
  protected abstract processJob(job: Job<TData, TResult, TName>, token?: string): Promise<TResult>;
}
