/**
 * The queue the extended network's rebuilds run on (#497). The API queues a
 * rebuild for each friendship change and the worker runs it. The braces are
 * the Dragonfly thread-affinity hash tag (see docs/REDIS.md).
 */
export const EXTENDED_NETWORK_QUEUE = '{bge.friendship.extended-network}';

export enum ExtendedNetworkJobNames {
  /** Rewrite the rows of every user within two friendship steps of one user. */
  RebuildAround = 'friendship.extended-network.rebuild-around',
  /** Rewrite every row from the friendships, one batch of users per run of the job. */
  RebuildAll = 'friendship.extended-network.rebuild-all',
}

/**
 * A rebuild job's payload: the user a `RebuildAround` rebuilds around. A
 * `RebuildAll` is queued with nothing, and records its progress between
 * batches: the last user it rebuilt from, and its counts so far.
 */
export interface ExtendedNetworkJob {
  readonly userId?: string;
  readonly after?: string;
  readonly removed?: number;
  readonly written?: number;
}
