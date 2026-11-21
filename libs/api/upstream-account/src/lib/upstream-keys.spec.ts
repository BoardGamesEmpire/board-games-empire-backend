import { Upstream } from '@bge/database';
import { UPSTREAM_KEYS, upstreamFromKey } from './upstream-keys';

describe('upstream keys (#935)', () => {
  it('gives every upstream its well-known path key', () => {
    expect(UPSTREAM_KEYS).toEqual({
      [Upstream.BoardGameGeek]: 'boardgamegeek',
      [Upstream.IGDB]: 'igdb',
      [Upstream.Steam]: 'steam',
    });
  });

  it.each(Object.values(Upstream))('reads %s back from its key', (upstream) => {
    expect(upstreamFromKey(UPSTREAM_KEYS[upstream])).toBe(upstream);
  });

  // The path carries the key, never the enum value: one spelling per upstream.
  it.each(['Steam', 'STEAM', ' steam', 'nope', ''])('refuses %p', (key) => {
    expect(upstreamFromKey(key)).toBeNull();
  });

  // A lookup on a plain object would answer these from its prototype.
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])('refuses the object key %p', (key) => {
    expect(upstreamFromKey(key)).toBeNull();
  });
});
