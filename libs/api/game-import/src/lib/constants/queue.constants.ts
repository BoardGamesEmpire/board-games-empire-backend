/**
 * BullMQ queue names.
 *
 * Wrapped in `{braces}`, which are Redis Cluster hash tags: only the bracketed
 * substring is hashed, so all of a queue's internal keys (`bull:{name}:wait`,
 * `bull:{name}:active`, ...) resolve to one slot. Dragonfly reuses the same
 * substring for thread placement, landing those keys on one CPU core.
 *
 * On a standalone server — which is every deployment BGE documents — braces are
 * ordinary key characters, so the convention is applied unconditionally.
 *
 * The two names below carry DIFFERENT tags, and the game-import flow spans both
 * through one `FlowProducer.add`. On a cluster that is a multi-key operation
 * across two slots and raises `CROSSSLOT`; bringing the flow's queues under a
 * single tag is a prerequisite for running BGE clustered.
 *
 * @see docs/REDIS.md — "BullMQ queue naming — the curly braces".
 */
export enum QueueNames {
  GamesImport = '{bge.games.import}',
  GatewayFetch = '{bge.gateway.fetch}',
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
