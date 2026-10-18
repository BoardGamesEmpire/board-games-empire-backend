'use strict';
const { shadowDatabaseProblem } = require('./shadow-database');

const MAIN = 'postgresql://bge:password@localhost:5432/board_games_empire?schema=board_games_empire';

describe('shadowDatabaseProblem (#586)', () => {
  it('names the variable when it is unset, rather than the prisma.config.ts setting Prisma names', () => {
    expect(shadowDatabaseProblem({ DATABASE_URL: MAIN })).toMatch(/^SHADOW_DATABASE_URL is not set/);
  });

  it('counts an empty value as unset, as prisma.config.ts does', () => {
    expect(shadowDatabaseProblem({ DATABASE_URL: MAIN, SHADOW_DATABASE_URL: '' })).toMatch(
      /^SHADOW_DATABASE_URL is not set/,
    );
  });

  it('accepts a database of its own on the same Postgres server', () => {
    expect(
      shadowDatabaseProblem({
        DATABASE_URL: MAIN,
        SHADOW_DATABASE_URL: 'postgresql://bge:password@localhost:5432/bge_shadow',
      }),
    ).toBeNull();
  });

  it("accepts CI's service, on a port of its own", () => {
    expect(
      shadowDatabaseProblem({
        DATABASE_URL: MAIN,
        SHADOW_DATABASE_URL: 'postgresql://postgres:postgres@localhost:32768/shadow',
      }),
    ).toBeNull();
  });

  // Prisma 7.8's `migrate diff --from-migrations` empties a shadow database
  // that is the main one and exits 0.
  it('refuses the main database, naming the variable it matched', () => {
    expect(shadowDatabaseProblem({ DATABASE_URL: MAIN, SHADOW_DATABASE_URL: MAIN })).toMatch(
      /^SHADOW_DATABASE_URL names the same database as DATABASE_URL \(localhost:5432\/board_games_empire\)/,
    );
  });

  // Read as Prisma's engine reads a URL: a `host` parameter wins over the URL's
  // host, and a socket directory or no host at all means this machine.
  it.each([
    ['another loopback address', 'postgresql://bge:password@127.0.0.1:5432/board_games_empire'],
    ['the postgres:// scheme', 'postgres://bge:password@localhost:5432/board_games_empire'],
    ['the default port left out', 'postgresql://bge:password@localhost/board_games_empire'],
    ['other query parameters', 'postgresql://bge:password@localhost:5432/board_games_empire?connection_limit=1'],
    ['another schema', 'postgresql://bge:password@localhost:5432/board_games_empire?schema=shadow'],
    ['another database role', 'postgresql://migrator:secret@LOCALHOST:5432/board_games_empire'],
    ['no host at all', 'postgresql:///board_games_empire'],
    ['a socket directory', 'postgresql://bge@db/board_games_empire?host=%2Fvar%2Frun%2Fpostgresql'],
    ['a host parameter naming this machine', 'postgresql://bge@db.internal/board_games_empire?host=127.0.0.1'],
  ])('refuses the main database spelled with %s', (_, shadow) => {
    expect(shadowDatabaseProblem({ DATABASE_URL: MAIN, SHADOW_DATABASE_URL: shadow })).toMatch(
      /^SHADOW_DATABASE_URL names the same database as DATABASE_URL/,
    );
  });

  // Prisma's engine reads a URL with no database as `postgres`; libpq and the
  // app's driver read it as the database role's own name.
  it.each([
    [
      'the shadow names no database, and the main one is postgres',
      MAIN.replace('/board_games_empire?', '/postgres?'),
      'postgresql://bge:password@localhost:5432',
    ],
    [
      'the main URL names no database, and the shadow is postgres',
      'postgresql://bge:password@localhost:5432',
      'postgresql://bge:password@localhost:5432/postgres',
    ],
    [
      'the main URL names no database, and the shadow is named for its database role',
      'postgresql://bge:password@localhost:5432/',
      'postgresql://other:secret@localhost:5432/bge',
    ],
    [
      'the main URL names no database role either, and the shadow is named for the login running the check',
      'postgresql://localhost:5432',
      'postgresql://other:secret@localhost:5432/jo',
    ],
  ])('refuses the same database when %s', (_, main, shadow) => {
    expect(shadowDatabaseProblem({ USER: 'jo', DATABASE_URL: main, SHADOW_DATABASE_URL: shadow })).toMatch(
      /^SHADOW_DATABASE_URL names the same database as DATABASE_URL/,
    );
  });

  it('compares a stray % as written, as Prisma does, rather than throwing', () => {
    const stray = 'postgresql://bge%@localhost:5432/board_games_empire%zz';
    expect(shadowDatabaseProblem({ DATABASE_URL: stray, SHADOW_DATABASE_URL: stray })).toMatch(
      /^SHADOW_DATABASE_URL names the same database as DATABASE_URL \(localhost:5432\/board_games_empire%zz\)/,
    );
  });

  it('refuses the database DATABASE_MIGRATION_URL names, which the CLI connects to when it is set', () => {
    expect(
      shadowDatabaseProblem({
        DATABASE_URL: 'postgresql://app:secret@db.internal:5432/bge',
        DATABASE_MIGRATION_URL: 'postgresql://migrator:secret@db.internal:5432/bge',
        SHADOW_DATABASE_URL: 'postgresql://migrator:secret@db.internal:5432/bge',
      }),
    ).toMatch(/same database as DATABASE_URL/);
    expect(
      shadowDatabaseProblem({
        DATABASE_URL: MAIN,
        DATABASE_MIGRATION_URL: 'postgresql://migrator:secret@db.internal:5432/bge',
        SHADOW_DATABASE_URL: 'postgresql://migrator:secret@db.internal:5432/bge',
      }),
    ).toMatch(/same database as DATABASE_MIGRATION_URL \(db\.internal:5432\/bge\)/);
  });

  // A URL it can't read could still be the main database, and Prisma would
  // empty it.
  it('refuses when it cannot read a main database URL, rather than guess', () => {
    expect(
      shadowDatabaseProblem({ DATABASE_URL: 'postgresql://bge@/board_games_empire', SHADOW_DATABASE_URL: MAIN }),
    ).toMatch(/^DATABASE_URL isn't a postgresql:\/\/ URL this check can read/);
  });

  it('refuses a shadow database URL it cannot read', () => {
    expect(shadowDatabaseProblem({ DATABASE_URL: MAIN, SHADOW_DATABASE_URL: 'not a url' })).toMatch(
      /^SHADOW_DATABASE_URL isn't a postgresql:\/\/ URL this check can read/,
    );
  });
});
