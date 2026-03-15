export enum SearchEvents {
  // Inbound (client → server)
  SearchStart = 'search:start',
  SearchCancel = 'search:cancel',

  // Outbound (server → client)
  SearchResult = 'search:result',
  SearchSourceDone = 'search:source_done',
  SearchDone = 'search:done',
  SearchError = 'search:error',
  SearchRateLimited = 'search:rate_limited',
  SearchUnavailable = 'search:unavailable',

  // Import job progress — emitted from the WS gateway once import jobs are wired
  ImportQueued = 'import:queued',
  ImportJobProgress = 'import:job_progress',
  ImportJobFailed = 'import:job_failed',
  ImportBatchComplete = 'import:batch_complete',
}

export type SearchEventKey = keyof typeof SearchEvents;
export type SearchEventValue = `${SearchEvents}`;
