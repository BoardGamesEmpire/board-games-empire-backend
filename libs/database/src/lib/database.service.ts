import { env } from '@bge/env';
import type { DatabasePoolMetricsSnapshot, DatabasePoolMetricsSource } from '@bge/otel';
import { createCaslExtension } from '@casl/prisma';
import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { Prisma, PrismaClient } from './client';

/**
 * Names the log levels Prisma may emit as events, so `$on` accepts them.
 * Without it the client is typed with no log events, and `$on` takes `never`.
 */
type DatabaseClientOptions = Required<Pick<Prisma.PrismaClientOptions, 'adapter'>> & {
  log: Array<{ emit: 'event'; level: Prisma.LogLevel }>;
};

@Injectable()
export class DatabaseService
  extends PrismaClient<DatabaseClientOptions>
  implements OnModuleInit, OnApplicationShutdown, DatabasePoolMetricsSource
{
  private readonly logger = new Logger(DatabaseService.name);

  /**
   * App-owned `pg` pool. We construct it explicitly (rather than letting
   * `PrismaPg` build one from a connection-string config) so its
   * connection-pool gauges are reachable via {@link getDatabasePoolMetrics}.
   * Prisma's `metrics` preview feature was removed in v7, so the driver
   * adapter's pool is the only source of pool-saturation signal. See #81.
   */
  private readonly pool: Pool;

  /** Read in the constructor because `log` is fixed at `super()`. */
  private readonly logQueries: boolean;

  constructor(configService: ConfigService) {
    Logger.log('Initializing DatabaseService', DatabaseService.name);

    const connectionString = configService.getOrThrow<string>('database.url');
    const schema = new URL(connectionString).searchParams.get('schema') ?? configService.get<string>('database.schema');
    const pool = new Pool({ connectionString });
    const logQueries = configService.get<boolean>('database.logQueries') === true;

    super({
      adapter: new PrismaPg(pool, { schema }),
      // Events, not the default stdout output: Prisma prints its own
      // multi-line `prisma:error` text there, outside the logger's redaction
      // and format (#627). Queries are opt-in, because a query line is noise
      // in development and the log is no place for their parameters.
      log: [
        { emit: 'event', level: 'error' },
        ...(env.isDevelopment
          ? ([
              { emit: 'event', level: 'warn' },
              { emit: 'event', level: 'info' },
            ] as const)
          : []),
        ...(logQueries ? ([{ emit: 'event', level: 'query' }] as const) : []),
      ],
    });

    this.pool = pool;
    this.logQueries = logQueries;

    // https://github.com/prisma/prisma/issues/18628#issuecomment-3213927054
    Object.assign(this, this.$extends(createCaslExtension()));
  }

  public async onModuleInit(): Promise<void> {
    try {
      await this.$connect();
      this.logger.log('Database connected');
    } catch (error) {
      this.logger.error(error);
      throw error;
    }

    this.$on('error', (e: Prisma.LogEvent) => this.logger.error(e.message));

    if (env.isDevelopment) {
      this.$on('warn', (e: Prisma.LogEvent) => this.logger.warn(e.message));
      this.$on('info', (e: Prisma.LogEvent) => this.logger.log(e.message));
    }

    if (this.logQueries) {
      // The query event's `params` are left out on purpose: they can carry
      // session tokens (#627).
      this.$on('query', (e: Prisma.QueryEvent) => {
        this.logger.log(`Query: ${e.query} (${e.duration}ms)`);
      });
    }
  }

  /**
   * Runs in `onApplicationShutdown`, after Nest has closed the HTTP server,
   * WebSockets and microservices. `onModuleDestroy` runs while they still
   * accept requests, so a request in that window would find the pool already
   * ended (#673).
   *
   * Nothing orders it after work that outlives a request. In the worker apps
   * BullMQ's global module closes its workers after this hook, so a job still
   * running can lose the pool (#738).
   */
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
    // An app-owned pool is not closed by Prisma's `$disconnect()`; we own
    // its lifecycle, so end it explicitly to release sockets on shutdown.
    await this.pool.end();
  }

  /**
   * {@link DatabasePoolMetricsSource} contract — a synchronous snapshot of
   * the pg pool gauges, read by `@bge/otel`'s `DbPoolMetricsRecorder`.
   */
  getDatabasePoolMetrics(): DatabasePoolMetricsSnapshot {
    const { totalCount, idleCount, waitingCount, options } = this.pool;

    return {
      open: totalCount,
      busy: totalCount - idleCount,
      idle: idleCount,
      pending: waitingCount,
      max: options.max,
    } satisfies DatabasePoolMetricsSnapshot;
  }
}
