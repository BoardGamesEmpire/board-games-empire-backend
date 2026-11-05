import { discardBody, type UpstreamFetch } from '@boardgamesempire/gateway-driver-contract';
import type { IGDBClient } from './igdb-client.interface';
import { IgdbHttpError } from './igdb-http.error';

export const IGDB_BASE_URL = 'https://api.igdb.com/v4';

export interface IgdbQueryOptions {
  /** How the query reaches IGDB; it has no other way (#1082). */
  fetch: UpstreamFetch;
  clientId: string;
  accessToken: string;

  /** Defaults to {@link IGDB_BASE_URL}. */
  baseUrl?: string;
}

/** The clauses a query can set once, by name. */
type Clause = 'fields' | 'search' | 'sort' | 'limit' | 'offset';

/**
 * One IGDB query, written in apicalypse as apicalypse 1.x wrote it for
 * igdb-api-node, and sent through the fetch the driver is handed (#1082).
 *
 * Each clause goes in the order it was first given, `where` clauses last,
 * each ending with `;`. `fields` loses its whitespace, `where` is trimmed, a
 * `limit` or `offset` of 0 is left out, and `sort` is ascending unless told
 * otherwise. A query keeps its clauses, so it serves one request only.
 */
export class IgdbQuery implements IGDBClient {
  private readonly clauses = new Map<Clause, string>();
  private readonly wheres: string[] = [];

  constructor(private readonly options: IgdbQueryOptions) {}

  fields(fields: string | readonly string[]): this {
    if (fields) {
      const list = typeof fields === 'string' ? fields : fields.join(',');
      this.clauses.set('fields', `fields ${list.replace(/\s/g, '')}`);
    }

    return this;
  }

  search(query: string): this {
    if (query) {
      this.clauses.set('search', `search "${query}"`);
    }

    return this;
  }

  where(clause: string): this {
    if (clause) {
      this.wheres.push(`where ${clause.trim()}`);
    }

    return this;
  }

  sort(field: string, direction?: 'asc' | 'desc'): this {
    if (field) {
      const named = / (asc|desc)$/i.test(field);
      this.clauses.set('sort', named ? `sort ${field}` : `sort ${field} ${direction ?? 'asc'}`);
    }

    return this;
  }

  limit(limit: number): this {
    if (limit) {
      this.clauses.set('limit', `limit ${limit}`);
    }

    return this;
  }

  offset(offset: number): this {
    if (offset) {
      this.clauses.set('offset', `offset ${offset}`);
    }

    return this;
  }

  /** The query as IGDB reads it. */
  toString(): string {
    const clauses = [...this.clauses.values(), ...this.wheres];
    return clauses.length === 0 ? '' : `${clauses.join(';')};`;
  }

  async request<T = unknown>(endpoint: string, signal?: AbortSignal): Promise<{ data: T[] }> {
    const response = await this.options.fetch(`${this.options.baseUrl ?? IGDB_BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'client-id': this.options.clientId,
        authorization: `Bearer ${this.options.accessToken}`,
        accept: 'application/json',
      },
      body: this.toString(),
      signal,
    });

    if (!response.ok) {
      await discardBody(response);
      throw new IgdbHttpError(response.status, endpoint);
    }

    return { data: (await response.json()) as T[] };
  }
}
