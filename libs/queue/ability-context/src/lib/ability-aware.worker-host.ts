import { AbilityService } from '@bge/permissions';
import { ActorAwareWorkerHost } from '@bge/queue-actor-context';
import { ForbiddenException, Inject } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';

/**
 * Base class for BullMQ processors that perform ability-filtered work.
 *
 * Extends {@link ActorAwareWorkerHost}: in addition to opening the actor /
 * correlation CLS scope from the job's `__meta` envelope, it primes the
 * originating actor's abilities into CLS before `processJob` runs — so a
 * processor can call `AbilityService.getCurrentResourceConditions(...)` exactly
 * as an HTTP handler does.
 *
 * Opt-in by design. Processors that do no ability-filtered queries (e.g. gateway
 * fetch/transform jobs) keep extending `ActorAwareWorkerHost` so they don't pull
 * in `@bge/permissions` and its DB/cache dependencies. Only processors that query
 * with the originating actor's abilities extend this.
 *
 * Priming is eager per job. A transient resolution failure (DB error) fails the
 * job so BullMQ retries — no silent degradation. A `ForbiddenException` is
 * different: at resolution time it means the actor's authority is structurally
 * gone (revoked api key, a plugin grant that can no longer render — #60),
 * which no retry can repair, so it is rethrown as BullMQ's `UnrecoverableError`
 * and the job fails once instead of retrying forever. Priming runs only in the
 * main `process` path, not in the lenient `runInActorScope` reused by
 * `@OnWorkerEvent` failure handlers.
 *
 * @example
 *   @Processor(QUEUE_NAMES.EVENT_REMINDERS)
 *   export class EventReminderProcessor extends AbilityAwareWorkerHost<ReminderJobData> {
 *     protected processJob(job: Job<ReminderJobData & JobMetaEnvelope>) {
 *       // CLS actor AND abilities are primed.
 *     }
 *   }
 */
export abstract class AbilityAwareWorkerHost<
  TData,
  TResult = unknown,
  TName extends string = string,
> extends ActorAwareWorkerHost<TData, TResult, TName> {
  // Property injection (not via `super()`) so subclasses never forward it through
  // their constructors; Nest resolves it against the concrete subclass provider.
  // `AbilityService` is ambient — `PermissionsModule` is `@Global()`.
  @Inject(AbilityService)
  private readonly abilityService!: AbilityService;

  protected override async onScopeReady(_job: Job<TData, TResult, TName>, _token?: string): Promise<void> {
    try {
      await this.abilityService.primeCurrentActor();
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw new UnrecoverableError(
          `Ability resolution refused for this job's actor (permanent): ${error.message}`,
        );
      }

      throw error;
    }
  }
}
