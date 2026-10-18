'use strict';
/**
 * Is SHADOW_DATABASE_URL safe to hand `prisma migrate diff --from-migrations`?
 *
 * Prisma empties the shadow database on every run, and Prisma 7.8 does so
 * without a word when it is the main database: on a throwaway database, a diff
 * given the main database as its shadow dropped the table already there,
 * replayed the migrations over it and exited 0 (#586). `migrate dev` refuses
 * that itself; `migrate diff` doesn't, so `npm run db:migrate:check` checks
 * first.
 *
 * Two URLs name the same database when their host, port and database match,
 * whatever the scheme, database role, query parameters or loopback spelling.
 * Each URL is read as Prisma's engine reads it, and a URL naming no database
 * is read every way the tools that use it read it. Another `schema` on the
 * same database counts as the same: the rule is a database of its own. A
 * Postgres server reached under two different host names still gets through.
 * A URL this can't read is refused rather than guessed at.
 */

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** The variables whose database the Prisma CLI connects to (prisma.config.ts). */
const MAIN_VARIABLES = ['DATABASE_URL', 'DATABASE_MIGRATION_URL'];

/**
 * Decodes the %XX runs that decode and keeps anything else as written, as
 * Prisma's engine does, so a stray `%` can't throw.
 */
function decode(text) {
  return text.replace(/(?:%[0-9a-f]{2})+/gi, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * Every `host:port/database` the URL can mean, or null when it isn't a
 * Postgres URL this can read.
 *
 * Prisma's engine takes the `host` parameter over the URL's host, and reads a
 * socket directory, or no host at all, as this machine. It reads no database
 * as `postgres`. libpq and the app's driver read no database as the database
 * role's own name, and no database role as the login running them.
 */
function databaseIdentities(url, env) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') return null;

  const named = (parsed.searchParams.get('host') ?? parsed.hostname).toLowerCase();
  const host = named === '' || named.startsWith('/') || LOOPBACK.has(named) ? 'localhost' : named;
  const port = parsed.port || '5432';

  const database = decode(parsed.pathname.split('/')[1] ?? '');
  const databaseRole = decode(parsed.username) || env['USER'] || env['USERNAME'];
  const databases = database ? [database] : ['postgres', databaseRole].filter(Boolean);

  return [...new Set(databases)].map((name) => `${host}:${port}/${name}`);
}

/**
 * Why the check can't run against this environment, or null when it can. An
 * empty value counts as unset, as it does in prisma.config.ts.
 */
function shadowDatabaseProblem(env) {
  const shadowUrl = env['SHADOW_DATABASE_URL'];
  if (!shadowUrl) {
    return (
      'SHADOW_DATABASE_URL is not set. The check replays the migrations into it, ' +
      'so set it to an empty database of its own; see .env.example.'
    );
  }

  const shadow = databaseIdentities(shadowUrl, env);
  if (shadow === null) {
    return "SHADOW_DATABASE_URL isn't a postgresql:// URL this check can read; see .env.example.";
  }

  for (const variable of MAIN_VARIABLES) {
    const value = env[variable];
    if (!value) continue;

    const main = databaseIdentities(value, env);
    if (main === null) {
      return (
        `${variable} isn't a postgresql:// URL this check can read, so it can't tell whether ` +
        'SHADOW_DATABASE_URL names the same database. Prisma empties the shadow database on every run, ' +
        'so the check stops here.'
      );
    }

    const same = shadow.find((identity) => main.includes(identity));
    if (same) {
      return (
        `SHADOW_DATABASE_URL names the same database as ${variable} (${same}). ` +
        'Prisma empties the shadow database on every run, so give it a database of its own.'
      );
    }
  }
  return null;
}

module.exports = { shadowDatabaseProblem };
