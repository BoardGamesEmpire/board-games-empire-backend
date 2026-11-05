/**
 * The fluent query the requests write, which `IgdbQuery` sends to IGDB.
 *
 * Each chain method returns `this` so calls can be composed. `request` is the
 * terminal operation: it sends the query to the endpoint and resolves with
 * the answer's rows under `data`. Its signal aborts the call (#1082).
 *
 * Generic parameter T is the expected element type of the response array
 * (e.g. IgdbGame). Defaults to `unknown` to enforce explicit typing at
 * call sites.
 */
export interface IGDBClient {
  fields(fields: string | readonly string[]): this;
  limit(limit: number): this;
  offset(offset: number): this;
  search(query: string): this;
  where(clause: string): this;
  sort(field: string, direction?: 'asc' | 'desc'): this;
  request<T = unknown>(endpoint: string, signal?: AbortSignal): Promise<{ data: T[] }>;
}

/**
 * A unit of work against IGDB: it takes a fresh client, and the signal that
 * aborts it, and resolves with the result. IgdbCaller builds a new client
 * for each attempt, since a client keeps its query's state.
 */
export type IgdbRequest<T> = (igdb: IGDBClient, signal: AbortSignal) => Promise<T>;
