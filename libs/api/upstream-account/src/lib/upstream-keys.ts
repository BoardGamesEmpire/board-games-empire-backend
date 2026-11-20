import { Upstream } from '@bge/database';

/** How a path and an answer spell an upstream: its well-known key (#935). */
export type UpstreamKey = 'boardgamegeek' | 'igdb' | 'steam';

/**
 * Each upstream's well-known key, which `users/me/upstream-accounts` routes
 * and answers carry in place of the enum value (#935).
 */
export const UPSTREAM_KEYS: Readonly<Record<Upstream, UpstreamKey>> = {
  [Upstream.BoardGameGeek]: 'boardgamegeek',
  [Upstream.IGDB]: 'igdb',
  [Upstream.Steam]: 'steam',
};

/** The keys read back, in a `Map` so a key such as `constructor` never reaches an object's prototype. */
const UPSTREAMS_BY_KEY: ReadonlyMap<string, Upstream> = new Map(
  Object.values(Upstream).map((upstream) => [UPSTREAM_KEYS[upstream], upstream]),
);

/** The upstream a well-known key names, or null for any other string, its enum value included. */
export function upstreamFromKey(key: string): Upstream | null {
  return UPSTREAMS_BY_KEY.get(key) ?? null;
}
