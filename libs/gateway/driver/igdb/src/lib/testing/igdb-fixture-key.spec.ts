import { igdbFixtureKey } from './igdb-fixture-key';

/**
 * The old client and the new one may write a query's clauses in a different
 * order, so a fixture's name comes from the clauses, not their order (#1082).
 */
describe('igdbFixtureKey', () => {
  it('names a request by its endpoint and a hash of its query', () => {
    expect(igdbFixtureKey('/games', 'fields id,name;limit 1;where id = 14593;')).toMatch(/^games-[0-9a-f]{12}$/);
  });

  it('gives the same clauses in another order the same key', () => {
    expect(igdbFixtureKey('/games', 'fields id,name;limit 1;where id = 14593;')).toBe(
      igdbFixtureKey('/games', 'where id = 14593; limit 1;fields id,name;'),
    );
  });

  it('gives a different query a different key', () => {
    expect(igdbFixtureKey('/games', 'fields id,name;limit 1;where id = 14593;')).not.toBe(
      igdbFixtureKey('/games', 'fields id,name;limit 1;where id = 1942;'),
    );
  });
});
