import { assertDataMigrationRegistry } from './plan-data-migrations';
import { DATA_MIGRATIONS } from './registry';

// The shipped registry through the same guard every plan runs it through, so
// a malformed or duplicated entry fails here before any database sees it.

describe('DATA_MIGRATIONS', () => {
  it('is a valid registry: unique timestamp-prefixed names and positive integer revisions', () => {
    expect(() => assertDataMigrationRegistry(DATA_MIGRATIONS)).not.toThrow();
  });
});
