import { AuditContextInternalService } from '@bge/actor-context';
import { WorkerHost } from '@nestjs/bullmq';
import { Inject } from '@nestjs/common';
import type { Job } from 'bullmq';
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
    const meta = extractJobMeta(job.data);

    if (!meta) {
      throw new Error(`Job ${job.queueName}#${job.id} missing __meta envelope; jobs must be enqueued via wrapJobData`);
    }

    return this.auditContext.runWith(
      {
        actor: meta.actor,
        correlationId: meta.correlationId,
        source: 'queue',
      },
      () => this.processJob(job, token),
    );
  }

  /**
   * Subclass entry point. CLS is populated when this is invoked.
   */
  protected abstract processJob(job: Job<TData, TResult, TName>, token?: string): Promise<TResult>;
}
