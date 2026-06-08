import type { Actor } from './types';

/**
 * Reserved key on `job.data` that carries actor + correlation context across
 * the queue boundary. Chosen with a double-underscore prefix to avoid collision
 * with user payload fields and to signal "framework reserved".
 */
export const JOB_META_KEY = '__meta' as const;

export interface JobActorMeta {
  /**
   * Actor of the entity that *originated* the job. For child jobs enqueued by
   * other jobs, this is the original triggering actor — not the parent worker.
   * Cascade jobs without a triggering actor (cron, system bootstrap) carry a
   * `{ kind: 'system', reason }` actor.
   */
  readonly actor: Actor;

  /**
   * Correlation id propagated from the originating request / parent job, so
   * downstream events on the queue can be tied back to the inbound transaction.
   */
  readonly correlationId: string;
}

export type JobMetaEnvelope = {
  readonly [JOB_META_KEY]: JobActorMeta;
};

/**
 * Wraps an arbitrary job payload with the actor + correlation envelope.
 * Producers call this when enqueueing.
 *
 * @example
 *   await queue.add('import', wrapJobData({ gameId }, { actor, correlationId }));
 */
export function wrapJobData<T extends Record<string, unknown>>(payload: T, meta: JobActorMeta): T & JobMetaEnvelope {
  return {
    ...payload,
    [JOB_META_KEY]: meta,
  };
}

/**
 * Reads the meta envelope from a job's data. Returns `null` if absent or
 * malformed. The worker base (`ActorAwareWorkerHost`) rejects such jobs — there
 * is no fallback actor; producers must enqueue via `wrapJobData`.
 */
export function extractJobMeta(data: unknown): JobActorMeta | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const candidate = (data as Record<string, unknown>)[JOB_META_KEY];
  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const meta = candidate as Partial<JobActorMeta>;
  if (!meta.actor || typeof meta.correlationId !== 'string') {
    return null;
  }

  return { actor: meta.actor, correlationId: meta.correlationId };
}
