/**
 * Fluent builder interface for igdb-api-node.
 *
 * Each chain method returns `this` so calls can be composed. `request` is the
 * terminal operation that executes the HTTP call and resolves with the raw
 * axios response; callers should read `.data` for the result array.
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
  request<T = unknown>(endpoint: string): Promise<{ data: T[] }>;
}
