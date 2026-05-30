import { Controller, Get, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckResult,
  HealthCheckService,
  HealthIndicatorFunction,
  HttpHealthIndicator,
} from '@nestjs/terminus';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import { type NextParameters, NextAsyncPre, SurrogateDelegate } from 'surrogate';
import { CacheRedisHealthIndicator } from './indicators/cache-redis.health-indicator';
import { PrismaHealthIndicator } from './indicators/prisma.health-indicator';
import { QueueRedisHealthIndicator } from './indicators/queue-redis.health-indicator';

/**
 * Shape returned by Surrogate when `ENABLE_HEALTH_CHECKS=false`. Distinct
 * from `HealthCheckResult` so consumers can discriminate between "no checks
 * ran" and "all checks passed".
 */
interface DisabledResponse {
  status: 'disabled';
}

const DISABLED_RESPONSE: DisabledResponse = { status: 'disabled' };

@SurrogateDelegate()
@ApiTags('health')
@AllowAnonymous()
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly health: HealthCheckService,
    private readonly http: HttpHealthIndicator,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly cacheRedisIndicator: CacheRedisHealthIndicator,
    private readonly queueRedisIndicator: QueueRedisHealthIndicator,
  ) {}

  /**
   * K8s liveness probe target. Returns 200 as long as the Node event loop
   * can respond to HTTP. No dependency checks — liveness failure causes K8s
   * to restart the pod, which is the right response for a hung process but
   * the wrong response for a transient DB blip.
   *
   * NEVER disabled via config: a liveness probe that can be silenced is
   * indistinguishable from no probe.
   */
  @Get('live')
  @ApiOkResponse({ description: 'Process is alive' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * K8s readiness probe target. Runs critical internal dependency checks:
   *   - Postgres (via Prisma)
   *   - Cache Redis  (optional-injection: passes with "not configured" if
   *                   the process didn't bind a cache connection)
   *   - Queue Redis  (same optional behavior)
   *
   * A failure returns 503; K8s removes the pod from rotation but does NOT
   * restart it. This is the right response for transient dependency outages.
   *
   * `ENABLE_HEALTH_CHECKS=false` short-circuits to `{ status: 'disabled' }`
   * with a 200 — the pod stays in rotation.
   */
  @HealthCheck()
  @Get('ready')
  @ApiOkResponse({ description: 'All critical dependencies healthy (or checks disabled)' })
  @ApiServiceUnavailableResponse({ description: 'One or more critical dependencies are unhealthy' })
  ready(): Promise<HealthCheckResult> | DisabledResponse {
    return this.health.check([
      () => this.prismaIndicator.isHealthy('database'),
      () => this.cacheRedisIndicator.isHealthy('cache'),
      () => this.queueRedisIndicator.isHealthy('queue'),
    ]);
  }

  /**
   * Extended health report — pings each URL in `HTTP_HEALTH_CHECK_URLS`.
   *
   * Intended for monitoring dashboards and on-call debugging, not K8s probes.
   * URLs are operator-configured as `name|url` pairs in the env var. A
   * failure returns 503 — operators should consume this from a monitoring
   * tool rather than a K8s readiness probe unless they explicitly want
   * external-URL availability to gate their pods.
   *
   * Empty configuration is fine; the indicator list is empty and Terminus
   * returns a passing result.
   */
  @HealthCheck()
  @Get()
  @ApiOkResponse({ description: 'All HTTP pings succeeded (or checks disabled / none configured)' })
  @ApiServiceUnavailableResponse({ description: 'One or more HTTP pings failed' })
  detail(): Promise<HealthCheckResult> | DisabledResponse {
    return this.health.check(this.buildHttpIndicators());
  }

  /**
   * Parses `HTTP_HEALTH_CHECK_URLS` (comma-separated `name|url` entries) into
   * Terminus indicator functions. Malformed entries (anything other than
   * exactly one `|` separator producing two non-empty parts) are silently
   * dropped — better to ping the well-formed entries than crash the entire
   * health endpoint over a typo in one URL.
   */
  private buildHttpIndicators(): HealthIndicatorFunction[] {
    return this.configService
      .get<string[]>('health.httpHealthCheckUrls', [])
      .map((entry) => entry.split('|'))
      .filter(
        (parts): parts is [string, string] =>
          parts.length === 2 && parts[0].trim().length > 0 && parts[1].trim().length > 0,
      )
      .map(
        ([name, url]) =>
          () =>
            this.http.pingCheck(name.trim(), url.trim()),
      );
  }

  @NextAsyncPre({
    action: ['ready', 'detail'],
    options: {
      runConditions(this: HealthController) {
        return this.configService.get<boolean>('health.enableHealthChecks', true) !== true;
      },
    },
  })
  protected onDisabled({ next }: NextParameters<HealthController>) {
    this.logger.warn('Health checks are disabled by configuration; returning 200 with status "disabled"');
    return next.bail({ bailWith: DISABLED_RESPONSE });
  }
}
