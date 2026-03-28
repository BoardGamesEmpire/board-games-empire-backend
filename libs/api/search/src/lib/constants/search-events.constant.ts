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
}

export type SearchEventKey = keyof typeof SearchEvents;
export type SearchEventValue = `${SearchEvents}`;
