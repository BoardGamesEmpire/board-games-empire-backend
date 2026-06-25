import { env } from '@bge/env';
import type { DatabasePoolMetricsSnapshot, DatabasePoolMetricsSource } from '@bge/otel';
import { createCaslExtension } from '@casl/prisma';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { Prisma, PrismaClient } from './client';

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleInit, OnModuleDestroy, DatabasePoolMetricsSource {
  private readonly logger = new Logger(DatabaseService.name);

  /**
   * App-owned `pg` pool. We construct it explicitly (rather than letting
   * `PrismaPg` build one from a connection-string config) so its
   * connection-pool gauges are reachable via {@link getDatabasePoolMetrics}.
   * Prisma's `metrics` preview feature was removed in v7, so the driver
   * adapter's pool is the only source of pool-saturation signal. See #81.
   */
  private readonly pool: Pool;

  constructor(private readonly configService: ConfigService) {
    Logger.log('Initializing DatabaseService', DatabaseService.name);

    const connectionString = configService.getOrThrow<string>('database.url');
    const schema = new URL(connectionString).searchParams.get('schema') ?? configService.get<string>('database.schema');
    const pool = new Pool({ connectionString });

    super({
      adapter: new PrismaPg(pool, { schema }),
      log: env.isDevelopment ? ['query', 'info', 'warn', 'error'] : ['error'],
    });

    this.pool = pool;

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

    if (this.configService.get<string>('database.logQueries')) {
      // @ts-expect-error - TS likes to whine about non-existent problems
      this.$on('query', (e: Prisma.QueryEvent) => {
        this.logger.log('Query: ' + e.query);
        this.logger.log('Params: ' + e.params);
        this.logger.log('Duration: ' + e.duration + 'ms');
      });
    }
  }

  async onModuleDestroy(): Promise<void> {
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
