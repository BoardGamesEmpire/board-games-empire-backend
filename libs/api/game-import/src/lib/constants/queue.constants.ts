export enum QueueNames {
  GamesImport = 'bge-games-import',
}

export const JobNames = {
  GameImport: 'game-import',
  ExpansionImport: 'expansion-import',
} as const;

export enum FlowProducerNames {
  GamesImport = 'bge:games-import:flow',
}

export enum ImportEvents {
  JobStarted = 'import.job.started',
  JobCompleted = 'import.job.completed',
  JobFailed = 'import.job.failed',
  BatchComplete = 'import.batch.complete',
}

/**
 * Client event names for the import gateway namespace ('games/import').
 */
export enum ClientImportEvents {
  // Inbound (client → server)
  ImportStart = 'import:start',

  // Outbound (server → client)
  ImportQueued = 'import:queued',
  ImportJobProgress = 'import:job_progress',
  ImportJobFailed = 'import:job_failed',
  ImportBatchComplete = 'import:batch_complete',
}
