/**
 * BullMQ queue names.
 *
 * Wrapped in `{braces}` for Dragonfly thread-affinity hashing. Dragonfly uses
 * the bracketed portion of a key to derive a hash slot for thread placement,
 * allowing all of a queue's internal Redis keys (`bull:{name}:wait`,
 * `bull:{name}:active`, etc.) to land on the same CPU core. The braces have
 * no effect on Redis or Valkey — they are treated as ordinary key characters
 * — so the convention is applied unconditionally.
 *
 * @see docs/REDIS.md — "Dragonfly — BullMQ queue naming" for the rationale.
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
