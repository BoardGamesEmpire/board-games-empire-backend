/**
 * BullMQ queue names.
 *
 * Each starts with a `{braces}` hash tag: only the bracketed substring is
 * hashed, so all of a queue's internal keys (`bull:{bge.games}.import:wait`,
 * ...) resolve to one slot. Dragonfly reuses the same substring for thread
 * placement and, with `--lock_on_hashtags`, for locking.
 *
 * The two queues share ONE tag because the game-import flow spans both: a
 * parent on the import queue with its fetch child on the fetch queue. The
 * script that adds the child reaches the parent's job key, and on Dragonfly
 * with `--lock_on_hashtags` a child under another tag is refused, BullMQ drops
 * the error, and the import waits forever (#462). The queue hash-tag check in
 * CI fails a flow whose child's tag differs from its parent's.
 *
 * On a standalone server — which is every deployment BGE documents — braces are
 * ordinary key characters, so the convention is applied unconditionally.
 *
 * @see docs/REDIS.md — "BullMQ queue naming — the curly braces".
 */
export enum QueueNames {
  GamesImport = '{bge.games}.import',
  GatewayFetch = '{bge.games}.fetch',
}

export enum JobNames {
  GameImport = 'game.import',
  ExpansionImport = 'expansion.import',
  GameFetch = 'game.fetch',
  ExpansionFetch = 'expansion.fetch',
}

/**
 * BullMQ FlowProducer names — DI identifiers, not Redis keys.
 */
export enum FlowProducerNames {
  GamesImport = 'bge.games.import.flow',
}

export enum ImportEvents {
  JobStarted = 'import.job.started',
  JobCompleted = 'import.job.completed',
  JobFailed = 'import.job.failed',
  BatchComplete = 'import.batch.complete',
}
