'use strict';
const { migrateDiffEnv, shadowDatabaseProblem } = require('./shadow-database');

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
      /^SHADOW_DATABASE_URL names the database board_games_empire, which DATABASE_URL can mean too/,
    );
  });

  // Two host names, loopback spellings or ports can reach the same server, and
  // no list of them is complete, so the main database's name is refused
  // wherever the shadow URL points.
  it.each([
    ['another host name', 'postgresql://bge:password@10.0.0.5:5432/board_games_empire'],
    ['an IPv4-mapped loopback address', 'postgresql://bge:password@[::ffff:127.0.0.1]:5432/board_games_empire'],
    ['another port, as a forwarded one can be', 'postgresql://bge:password@localhost:15432/board_games_empire'],
    ['a host parameter naming another machine', 'postgresql://bge@localhost/board_games_empire?host=db.internal'],
    ['the postgres:// scheme', 'postgres://bge:password@localhost:5432/board_games_empire'],
    ['another schema', 'postgresql://bge:password@localhost:5432/board_games_empire?schema=shadow'],
    ['another database role', 'postgresql://migrator:secret@LOCALHOST:5432/board_games_empire'],
    ['no host at all', 'postgresql:///board_games_empire'],
  ])("refuses the main database's name with %s", (_, shadow) => {
    expect(shadowDatabaseProblem({ DATABASE_URL: MAIN, SHADOW_DATABASE_URL: shadow })).toMatch(
      /^SHADOW_DATABASE_URL names the database board_games_empire, which DATABASE_URL can mean too/,
    );
  });

  // Prisma's engine reads a URL with no database as `postgres`. libpq and the
  // app's driver read it as PGDATABASE, then as the database role's own name,
  // and no database role as PGUSER, then as the login running them.
  it.each([
    [
      'the shadow names no database, and the main one is postgres',
      {},
      MAIN.replace('/board_games_empire?', '/postgres?'),
      'postgresql://bge:password@localhost:5432',
    ],
    [
      'the main URL names no database, and the shadow is postgres',
      {},
      'postgresql://bge:password@localhost:5432',
      'postgresql://bge:password@localhost:5432/postgres',
    ],
    [
      'the main URL names no database, and the shadow is named for its database role',
      {},
      'postgresql://bge:password@localhost:5432/',
      'postgresql://other:secret@localhost:5432/bge',
    ],
    [
      'the main URL names no database role either, and the shadow is named for the login running the check',
      {},
      'postgresql://localhost:5432',
      'postgresql://other:secret@localhost:5432/jo',
    ],
    [
      'the main URL names no database, and the shadow is PGDATABASE',
      { PGDATABASE: 'production' },
      'postgresql://app@localhost:5432',
      'postgresql://app@localhost:5432/production',
    ],
    [
      'the main URL names no database role, and the shadow is named for PGUSER',
      { PGUSER: 'app' },
      'postgresql://localhost:5432',
      'postgresql://other:secret@localhost:5432/app',
    ],
  ])('refuses the same database when %s', (_, pg, main, shadow) => {
    expect(shadowDatabaseProblem({ USER: 'jo', ...pg, DATABASE_URL: main, SHADOW_DATABASE_URL: shadow })).toMatch(
      /^SHADOW_DATABASE_URL names the database \S+, which DATABASE_URL can mean too/,
    );
  });

  it('compares a stray % as written, as Prisma does, rather than throwing', () => {
    const stray = 'postgresql://bge%@localhost:5432/board_games_empire%zz';
    expect(shadowDatabaseProblem({ DATABASE_URL: stray, SHADOW_DATABASE_URL: stray })).toMatch(
      /^SHADOW_DATABASE_URL names the database board_games_empire%zz, which DATABASE_URL can mean too/,
    );
  });

  it('refuses the database DATABASE_MIGRATION_URL names, which the CLI connects to when it is set', () => {
    expect(
      shadowDatabaseProblem({
        DATABASE_URL: 'postgresql://app:secret@db.internal:5432/bge',
        DATABASE_MIGRATION_URL: 'postgresql://migrator:secret@db.internal:5432/bge',
        SHADOW_DATABASE_URL: 'postgresql://migrator:secret@db.internal:5432/bge',
      }),
    ).toMatch(/which DATABASE_URL can mean too/);
    expect(
      shadowDatabaseProblem({
        DATABASE_URL: MAIN,
        DATABASE_MIGRATION_URL: 'postgresql://migrator:secret@db.internal:5432/bge',
        SHADOW_DATABASE_URL: 'postgresql://migrator:secret@db.internal:5432/bge',
      }),
    ).toMatch(/the database bge, which DATABASE_MIGRATION_URL can mean too/);
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

// The migrations replay into the shadow URL's schema, but Prisma places the
// models in the schema of the URL prisma.config.ts reads. With `.env.example`'s
// `board_games_empire` there and none on CI's shadow URL, every table differed
// by its schema alone and the check failed on matching migrations.
describe('migrateDiffEnv (#586)', () => {
  const SHADOW = 'postgresql://postgres:postgres@localhost:32768/shadow';

  it("compares the models in `public` when the shadow URL names no schema, Prisma's default", () => {
    expect(migrateDiffEnv({ DATABASE_URL: MAIN, SHADOW_DATABASE_URL: SHADOW }).DATABASE_URL).toBe(
      'postgresql://bge:password@localhost:5432/board_games_empire?schema=public',
    );
  });

  it('compares the models in the schema the shadow URL names', () => {
    expect(migrateDiffEnv({ DATABASE_URL: MAIN, SHADOW_DATABASE_URL: `${SHADOW}?schema=check` }).DATABASE_URL).toBe(
      'postgresql://bge:password@localhost:5432/board_games_empire?schema=check',
    );
  });

  it('sets the schema on DATABASE_MIGRATION_URL as well, which prisma.config.ts reads first', () => {
    const env = migrateDiffEnv({
      DATABASE_URL: 'postgresql://app:secret@db.internal:5432/bge',
      DATABASE_MIGRATION_URL: 'postgresql://migrator:secret@db.internal:5432/bge?connection_limit=1',
      SHADOW_DATABASE_URL: SHADOW,
    });
    expect(env.DATABASE_URL).toBe('postgresql://app:secret@db.internal:5432/bge?schema=public');
    expect(env.DATABASE_MIGRATION_URL).toBe(
      'postgresql://migrator:secret@db.internal:5432/bge?connection_limit=1&schema=public',
    );
  });

  it('leaves an unset or empty main URL alone, and the rest of the environment as it was', () => {
    const env = migrateDiffEnv({
      DATABASE_URL: MAIN,
      DATABASE_MIGRATION_URL: '',
      SHADOW_DATABASE_URL: SHADOW,
      PATH: '/bin',
    });
    expect(env).toEqual({
      DATABASE_URL: 'postgresql://bge:password@localhost:5432/board_games_empire?schema=public',
      DATABASE_MIGRATION_URL: '',
      SHADOW_DATABASE_URL: SHADOW,
      PATH: '/bin',
    });
  });
});
