import type { IgdbRequest } from '../igdb/igdb.service';
import type { IGDBClient } from '../igdb/interfaces';
import type { IgdbNamedEntity, IgdbPlatform } from '../types';

/** The most IGDB answers in one request, so a list is asked for a page at a time. */
export const IGDB_LIST_PAGE_SIZE = 500;

/**
 * One page of IGDB's platforms, by id so the pages don't overlap, for the
 * platform list the server loads after an interview (#718).
 */
export function listPlatformsRequest(offset: number): IgdbRequest<IgdbPlatform[]> {
  return listPage<IgdbPlatform>('/platforms', ['id', 'name', 'abbreviation', 'platform_type'], offset);
}

/** One page of IGDB's genres, which the server stores as categories (#718). */
export function listGenresRequest(offset: number): IgdbRequest<IgdbNamedEntity[]> {
  return listPage<IgdbNamedEntity>('/genres', ['id', 'name'], offset);
}

function listPage<T>(endpoint: string, fields: readonly string[], offset: number): IgdbRequest<T[]> {
  return (client: IGDBClient) =>
    client
      .fields(fields)
      .sort('id', 'asc')
      .limit(IGDB_LIST_PAGE_SIZE)
      .offset(offset)
      .request<T>(endpoint)
      .then((response) => response.data);
}
