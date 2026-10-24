import { DatabaseService, MIGRATION_NAMES } from '@bge/database';
import { structuredLogMessage } from '@bge/logger';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PgAdvisoryLock } from './advisory-lock';
import { BOOTSTRAP_OPTIONS, CACHE_FLUSH, type BootstrapModuleOptions } from './bootstrap-options';
import { RegistryDataMigrations } from './data-migrations-phase';
import {
  databaseRoleIn,
  MIGRATION_URL_VARIABLE,
  resolveMigrationCredential,
  unusedMigrationCredentialWarning,
} from './migration-credential';
import type { BootstrapLogger, CacheFlush } from './ports';
import { PrismaSchemaLedger } from './prisma-ledger';
import { runBootstrapSequence, type BootstrapSummary } from './runner';
import { RunSeedsSeeder } from './seeder';

/**
 * Wires the real ports to the runner: the app's Prisma client for the ledger,
 * the seeds and the data migrations, a dedicated pg connection for the lock,
 * the api-only migrator from the module options over the migration credential,
 * and the cache flush when the module was given a cache, handed to both DML
 * phases. One `run()` per process boot.
 */
@Injectable()
export class BootstrapService {
  private readonly nest = new Logger(BootstrapService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    @Inject(BOOTSTRAP_OPTIONS) private readonly options: BootstrapModuleOptions,
    @Optional() @Inject(CACHE_FLUSH) private readonly cacheFlush?: CacheFlush,
  ) {}

  async run(): Promise<BootstrapSummary> {
    const logger = this.bootstrapLogger();
    const databaseUrl = this.config.getOrThrow<string>('database.url');
    const migration = resolveMigrationCredential({
      databaseUrl,
      migrationUrl: this.config.get<string>('database.migrationUrl'),
    });

    // Per process, not per process role: a process that runs the api has the
    // migrator, whatever else runs beside it.
    if (!this.options.migrator && migration.credential.variable === MIGRATION_URL_VARIABLE) {
      logger.warn(unusedMigrationCredentialWarning(this.options.applicationName));
    }

    const lock = new PgAdvisoryLock({
      connectionString: databaseUrl,
      logger,
      applicationName: `bge-bootstrap:${this.options.applicationName}`,
    });

    try {
      const summary = await runBootstrapSequence({
        expected: MIGRATION_NAMES,
        ledger: new PrismaSchemaLedger(this.db, { databaseRole: databaseRoleIn(databaseUrl) }),
        lock,
        seeder: new RunSeedsSeeder(this.db, { flush: this.cacheFlush }),
        dataMigrations: new RegistryDataMigrations(this.db, { flush: this.cacheFlush }),
        migrator: this.options.migrator?.({ migrationUrl: migration.url, logger }),
        migrationCredential: migration.credential,
        logger,
        waitMs: this.options.waitMs,
        schemaPollMs: this.options.schemaPollMs,
      });

      logger.log('Bootstrap complete', { ...summary });
      return summary;
    } finally {
      try {
        await lock.close();
      } finally {
        await this.cacheFlush?.close();
      }
    }
  }

  /** The runner's structural logger over this service's Nest logger; fields ride as a {@link StructuredLogMessage}. */
  private bootstrapLogger(): BootstrapLogger {
    return {
      log: (message, fields) => this.nest.log(structuredLogMessage(message, fields)),
      warn: (message, fields) => this.nest.warn(structuredLogMessage(message, fields)),
    };
  }
}
