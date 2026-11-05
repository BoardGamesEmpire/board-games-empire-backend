import type { BggClientLike, BggSearchResult, BggThing } from '@bge/gateway-driver-boardgamegeek';
import type { BggClient } from 'bgg-ts-client';

/** The fields that hold BGG's text, which bgg-ts-client's parser can turn into a number or a boolean. */
const TEXT_FIELDS = new Set(['name', 'alternateNames', 'description', 'value', 'inbound', 'productcode']);

/** A copy of `node` with every text field that arrived as a number or a boolean turned back into text. */
function textAsText(node: unknown, field?: string): unknown {
  if (Array.isArray(node)) {
    return node.map((each) => textAsText(each, field));
  }

  if (typeof node === 'object' && node !== null) {
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, textAsText(value, key)]));
  }

  const parsed = typeof node === 'number' || typeof node === 'boolean';
  return field !== undefined && TEXT_FIELDS.has(field) && parsed ? String(node) : node;
}

/** The request builders' thing types are bgg-ts-client's, spelled as strings. */
type ThingRequest = Parameters<BggClient['thing']['query']>[0];
type SearchRequest = Parameters<BggClient['search']['query']>[0];

/**
 * bgg-ts-client as the request builders and mappers now take it: text as
 * text, and a search query handed over as typed, as the driver's own client
 * takes them (#863, #969, #1082).
 *
 * bgg-ts-client joins parameters into the URL unencoded, so this encodes the
 * query, or & + and # would cut or change it. Its parser turns text that
 * looks like a number or a boolean into one, so this turns it back. What that
 * parser already lost stays lost: "007" comes back as "7". This goes with
 * bgg-ts-client, once the app hosts the driver.
 */
export function adaptBggTsClient(client: BggClient): BggClientLike {
  return {
    thing: {
      query: async (params) => textAsText(await client.thing.query(params as ThingRequest)) as BggThing[],
    },
    search: {
      query: async (params) =>
        textAsText(
          await client.search.query({ ...params, query: encodeURIComponent(params.query) } as SearchRequest),
        ) as BggSearchResult[],
    },
  };
}
