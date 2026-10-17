/** The variable that holds the migration credential, when the operator gives the migrations a credential of their own. */
export const MIGRATION_URL_VARIABLE = 'DATABASE_MIGRATION_URL';
/** The variable every process role connects with, and the migration credential when the one above is unset. */
export const DATABASE_URL_VARIABLE = 'DATABASE_URL';

/**
 * Where the migrations reach Postgres (#445): the variable the migrator's URL
 * came from, and that URL's user and host. Never its password, because the
 * boot summary that carries it is logged.
 */
export interface MigrationCredential {
  readonly variable: typeof MIGRATION_URL_VARIABLE | typeof DATABASE_URL_VARIABLE;
  readonly user: string;
  readonly host: string;
}

export interface ResolvedMigrationCredential {
  /** What the migrator connects with. */
  readonly url: string;
  /** What the boot summary and the refusals say about it. */
  readonly credential: MigrationCredential;
}

/**
 * The migration credential (#445): `DATABASE_MIGRATION_URL` when it is set,
 * and `DATABASE_URL` otherwise. Empty counts as unset, as it does in
 * `prisma.config.ts`, so a variable blanked in one environment block does not
 * point the migrations at nothing.
 */
export function resolveMigrationCredential(urls: {
  readonly databaseUrl: string;
  readonly migrationUrl?: string;
}): ResolvedMigrationCredential {
  const { url, variable } = urls.migrationUrl
    ? ({ url: urls.migrationUrl, variable: MIGRATION_URL_VARIABLE } as const)
    : ({ url: urls.databaseUrl, variable: DATABASE_URL_VARIABLE } as const);

  return { url, credential: { variable, ...(userAndHost(url) ?? { user: 'unknown', host: 'unknown' }) } };
}

/** The database role a URL connects as, when it names one. */
export function databaseRoleIn(url: string): string | undefined {
  return userAndHost(url)?.user || undefined;
}

/**
 * The warning for a process that applies no migrations and was given the
 * migration credential anyway: nothing uses it there, and least privilege
 * means it should not be there.
 */
export function unusedMigrationCredentialWarning(processRole: string): string {
  return (
    `${MIGRATION_URL_VARIABLE} is set for the ${processRole} process role, which applies no migrations: only the api does. ` +
    `Remove it from this process's configuration, so the migration credential reaches only the process that uses it.`
  );
}

/**
 * A URL that does not parse cannot connect either, and the connection's own
 * error is the one worth reading; describing it is not worth a second failure.
 */
function userAndHost(url: string): Pick<MigrationCredential, 'user' | 'host'> | undefined {
  try {
    const parsed = new URL(url);
    return { user: decodeURIComponent(parsed.username), host: parsed.host };
  } catch {
    return undefined;
  }
}
