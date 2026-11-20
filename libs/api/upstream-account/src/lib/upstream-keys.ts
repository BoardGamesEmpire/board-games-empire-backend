import { Upstream } from '@bge/database';

/**
 * Each upstream's well-known key, which `users/me/upstream-accounts` routes
 * and answers carry in place of the enum value (#935).
 */
export const UPSTREAM_KEYS = {
  [Upstream.BoardGameGeek]: 'boardgamegeek',
  [Upstream.IGDB]: 'igdb',
  [Upstream.Steam]: 'steam',
} as const satisfies Record<Upstream, string>;

/** How a path and an answer spell an upstream: its well-known key (#935). */
export type UpstreamKey = (typeof UPSTREAM_KEYS)[Upstream];

/** Every well-known upstream key, for the answers' Swagger enums and the unknown-key message. */
export const UPSTREAM_KEY_VALUES: readonly UpstreamKey[] = Object.values(UPSTREAM_KEYS);

/** The keys read back, in a `Map` so a key such as `constructor` never reaches an object's prototype. */
const UPSTREAMS_BY_KEY: ReadonlyMap<string, Upstream> = new Map(
  Object.values(Upstream).map((upstream) => [UPSTREAM_KEYS[upstream], upstream]),
);

/** The upstream a well-known key names, or null for any other string, its enum value included. */
export function upstreamFromKey(key: string): Upstream | null {
  return UPSTREAMS_BY_KEY.get(key) ?? null;
}
