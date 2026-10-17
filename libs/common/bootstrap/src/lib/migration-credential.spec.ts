import { databaseRoleIn, resolveMigrationCredential, unusedMigrationCredentialWarning } from './migration-credential';

// What the api migrates with, and what its boot summary says about it. The
// summary is logged, so the password must never reach it.

describe('resolveMigrationCredential', () => {
  const databaseUrl = 'postgresql://bge_app:app-secret@bge-pooler-rw:5432/bge';
  const migrationUrl = 'postgresql://bge_migrator:migrator-secret@bge-rw:5432/bge';

  it('migrates with DATABASE_MIGRATION_URL when it is set, and names its user and host', () => {
    const resolved = resolveMigrationCredential({ databaseUrl, migrationUrl });

    expect(resolved.url).toBe(migrationUrl);
    expect(resolved.credential).toEqual({
      variable: 'DATABASE_MIGRATION_URL',
      user: 'bge_migrator',
      host: 'bge-rw:5432',
    });
  });

  it('falls back to DATABASE_URL when DATABASE_MIGRATION_URL is unset or empty', () => {
    for (const unset of [undefined, '']) {
      const resolved = resolveMigrationCredential({ databaseUrl, migrationUrl: unset });

      expect(resolved.url).toBe(databaseUrl);
      expect(resolved.credential).toEqual({ variable: 'DATABASE_URL', user: 'bge_app', host: 'bge-pooler-rw:5432' });
    }
  });

  it('never carries the password', () => {
    const { credential } = resolveMigrationCredential({ databaseUrl, migrationUrl });

    expect(JSON.stringify(credential)).not.toContain('secret');
  });

  it('decodes a percent-encoded user, as Postgres receives it', () => {
    const { credential } = resolveMigrationCredential({
      databaseUrl,
      migrationUrl: 'postgresql://bge%40migrations:pw@bge-rw/bge',
    });

    expect(credential.user).toBe('bge@migrations');
    expect(credential.host).toBe('bge-rw');
  });

  it('describes a user or host the URL leaves to the environment as unknown, as it does an unparseable URL', () => {
    expect(
      resolveMigrationCredential({ databaseUrl, migrationUrl: 'postgresql://bge-rw:5432/bge' }).credential,
    ).toEqual({
      variable: 'DATABASE_MIGRATION_URL',
      user: 'unknown',
      host: 'bge-rw:5432',
    });
    expect(resolveMigrationCredential({ databaseUrl, migrationUrl: 'postgresql:///bge' }).credential).toEqual({
      variable: 'DATABASE_MIGRATION_URL',
      user: 'unknown',
      host: 'unknown',
    });
  });

  it('describes a URL it cannot parse as unknown rather than failing the boot over a log field', () => {
    const resolved = resolveMigrationCredential({ databaseUrl, migrationUrl: 'not a url' });

    expect(resolved.url).toBe('not a url');
    expect(resolved.credential).toEqual({ variable: 'DATABASE_MIGRATION_URL', user: 'unknown', host: 'unknown' });
  });
});

// The database role in DATABASE_URL, which the ledger refusal names.
describe('databaseRoleIn', () => {
  it('names the database role a URL connects as, decoded as Postgres receives it', () => {
    expect(databaseRoleIn('postgresql://bge_app:app-secret@bge-pooler-rw:5432/bge')).toBe('bge_app');
    expect(databaseRoleIn('postgresql://bge%40app:pw@bge-pooler-rw/bge')).toBe('bge@app');
  });

  it('names none when the URL leaves the user to the environment, or does not parse', () => {
    expect(databaseRoleIn('postgresql://bge-pooler-rw:5432/bge')).toBeUndefined();
    expect(databaseRoleIn('not a url')).toBeUndefined();
  });
});

describe('unusedMigrationCredentialWarning', () => {
  it('names the variable, and the process role that applies no migrations and should not hold it', () => {
    const warning = unusedMigrationCredentialWarning('worker');

    expect(warning).toContain('DATABASE_MIGRATION_URL is set for the worker process role');
    expect(warning).toContain('only the api does');
  });
});
