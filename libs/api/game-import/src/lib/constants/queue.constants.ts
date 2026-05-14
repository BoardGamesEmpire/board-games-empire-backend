export enum QueueNames {
  GamesImport = 'bge.games.import',
  GatewayFetch = 'bge.gateway.fetch',
}

export enum JobNames {
  GameImport = 'game.import',
  ExpansionImport = 'expansion.import',
  GameFetch = 'game.fetch',
  ExpansionFetch = 'expansion.fetch',
}

export enum FlowProducerNames {
  GamesImport = 'bge.games.import.flow',
}

export enum ImportEvents {
  JobStarted = 'import.job.started',
  JobCompleted = 'import.job.completed',
  JobFailed = 'import.job.failed',
  BatchComplete = 'import.batch.complete',
}
