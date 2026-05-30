import { DatabaseService } from '@bge/database';
import { Injectable } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';

/**
 * Terminus health indicator for PostgreSQL via Prisma.
 *
 * Runs `SELECT 1` against the primary connection — validates the connection
 * pool is live and can execute queries. Does NOT assess replication lag,
 * read-replica reachability, or schema migration state.
 *
 * Uses the Terminus v11 `HealthIndicatorService` API (consistent with the
 * cache/queue Redis indicators). The legacy `HealthIndicator` base class
 * and `HealthCheckError` are deprecated in v11 and avoided here.
 *
 * Unlike the Redis indicators, this indicator is NOT optional-injection.
 * Every BGE process that loads HealthModule also loads DatabaseModule
 * (auth, CASL, and every domain depend on the DB), so a missing
 * `DatabaseService` would indicate a wiring bug rather than an intentional
 * topology — failing loudly is correct.
 */
@Injectable()
export class PrismaHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    private readonly db: DatabaseService,
  ) {}

  async isHealthy(key = 'database'): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      await this.db.$queryRaw`SELECT 1`;
      return indicator.up();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return indicator.down({ message });
    }
  }
}
