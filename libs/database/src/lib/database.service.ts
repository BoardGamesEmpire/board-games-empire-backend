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

/** One handler per Prisma log level, typed with the event `$on` passes for it. */
type PrismaLogHandlers = {
  [Level in Prisma.LogLevel]: (event: Level extends 'query' ? Prisma.QueryEvent : Prisma.LogEvent) => void;
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

  constructor(configService: ConfigService) {
    Logger.log('Initializing DatabaseService', DatabaseService.name);

    const connectionString = configService.getOrThrow<string>('database.url');
    const schema = new URL(connectionString).searchParams.get('schema') ?? configService.get<string>('database.schema');
    const pool = new Pool({ connectionString });
    // Queries are opt-in, because a query line is noise in development and
    // the log is no place for their parameters.
    const levels: Prisma.LogLevel[] = [
      'error',
      ...(env.isDevelopment ? (['warn', 'info'] as const) : []),
      ...(configService.get<boolean>('database.logQueries') === true ? (['query'] as const) : []),
    ];

    super({
      adapter: new PrismaPg(pool, { schema }),
      // Events, not the default stdout output: Prisma prints its own
      // multi-line `prisma:error` text there, outside the logger's redaction
      // and format (#627).
      log: levels.map((level) => ({ emit: 'event', level })),
    });

    this.pool = pool;

    // Listened for here, before anything can query: with `emit: 'event'`
    // Prisma prints nothing itself, so an event emitted before its listener
    // exists is lost.
    const handlers: PrismaLogHandlers = {
      error: (e) => this.logger.error(e.message),
      warn: (e) => this.logger.warn(e.message),
      info: (e) => this.logger.log(e.message),
      // The query event's `params` are left out on purpose: they can carry
      // session tokens (#627).
      query: (e) => this.logger.log(`Query: ${e.query} (${e.duration}ms)`),
    };
    const listen = <Level extends Prisma.LogLevel>(level: Level) => this.$on(level, handlers[level]);
    levels.forEach(listen);

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
