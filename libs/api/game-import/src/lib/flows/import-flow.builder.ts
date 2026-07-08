import { wrapJobData, type JobActorMeta } from '@bge/queue-actor-context';
import type { FlowJob, JobsOptions } from 'bullmq';
import { JobNames, QueueNames } from '../constants/queue.constants';
import type { ExpansionImportJobPayload, GameImportJobPayload } from '../interfaces/import-job.interface';

const KEEP_HISTORY = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
} as const satisfies JobsOptions;

/**
 * Options for the import (persist) nodes — GameImport / ExpansionImport.
 *
 * Deliberately NO `attempts`: an import node is also the cascade target of its
 * fetch child's `failParentOnFailure`. With `attempts > 1`, a force-failed
 * parent lands in `onFailed` with `attemptsMade < attempts`, so the retry guard
 * early-returns and skips the Failed transition + expansion-cancellation sweep
 * — hanging the batch. The persist step is near-deterministic anyway, so a
 * single attempt is correct; retries live on the fetch nodes below.
 */
export const IMPORT_JOB_OPTS: JobsOptions = { ...KEEP_HISTORY };

/**
 * Options for the fetch (gateway) child nodes — GameFetch / ExpansionFetch.
 * Transient failures live here, so this is where retries + backoff belong.
 * `failParentOnFailure` cascades a persistent fetch failure to its own import
 * parent so the import never waits forever on a dead fetch.
 */
export const FETCH_JOB_OPTS: JobsOptions = {
  ...KEEP_HISTORY,
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  failParentOnFailure: true,
};

/**
 * Builds one import flow — an import (persist) parent with its single fetch
 * child. Shared by the base flow (coordinator) and each expansion flow
 * (spawner); they differ only in the job names and the payload shape. Both
 * nodes' BullMQ jobId is pinned to the Job row id, so it is stable across
 * retries (idempotent re-add) and `bullmqJobId` equals the row id.
 */
function buildImportFlow(
  names: { readonly import: JobNames; readonly fetch: JobNames },
  payload: GameImportJobPayload,
  meta: JobActorMeta,
): FlowJob {
  return {
    name: names.import,
    queueName: QueueNames.GamesImport,
    data: wrapJobData(payload, meta),
    opts: { jobId: payload.jobId, ...IMPORT_JOB_OPTS },
    children: [
      {
        name: names.fetch,
        queueName: QueueNames.GatewayFetch,
        // The fetch payload is a subset of the import payload; the extra
        // import-only fields (e.g. expansionExternalIds) are harmless to the
        // fetch processor, which reads only what GameFetchJobPayload declares.
        data: wrapJobData({ ...payload }, meta),
        opts: { jobId: payload.jobId, ...FETCH_JOB_OPTS },
      },
    ],
  };
}

/** Base import flow: `GameImport` parent + its `GameFetch` child. */
export function buildBaseFlow(payload: GameImportJobPayload, meta: JobActorMeta): FlowJob {
  return buildImportFlow({ import: JobNames.GameImport, fetch: JobNames.GameFetch }, payload, meta);
}

/**
 * Expansion import flow: `ExpansionImport` parent + its `ExpansionFetch` child.
 * An independent root flow (no base parent) sharing the batchId — so an
 * expansion failure never cascades to the already-completed base. Spawned by
 * the base processor and enqueued with `FlowProducer.addBulk`.
 */
export function buildExpansionFlow(payload: ExpansionImportJobPayload, meta: JobActorMeta): FlowJob {
  return buildImportFlow({ import: JobNames.ExpansionImport, fetch: JobNames.ExpansionFetch }, payload, meta);
}
