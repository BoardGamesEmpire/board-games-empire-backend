import { CodedHttpException, t } from '@bge/i18n';
import { Controller, Get, Req, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOkResponse, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckResult, HealthCheckService, HealthIndicatorFunction } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { Http } from '@status/codes';
import { AllowAnonymous } from '@thallesp/nestjs-better-auth';
import type { IncomingMessage } from 'node:http';
import { CacheRedisHealthIndicator } from './indicators/cache-redis.health-indicator';
import { HttpTargetHealthIndicator } from './indicators/http-target.health-indicator';
import { PrismaHealthIndicator } from './indicators/prisma.health-indicator';
import { QueueRedisHealthIndicator } from './indicators/queue-redis.health-indicator';
import { StorageHealthIndicator } from './indicators/storage.health-indicator';
import { isOperationalRequest } from './operational-request';

/**
 * Exempt from rate limiting, for the reason the liveness docblock below already
 * gives: a probe that can be silenced is indistinguishable from no probe, and a
 * 429 silences it exactly the way a config flag would.
 *
 * The global `default` throttler keys on handler AND source IP, so each route
 * here has its own bucket and `/metrics` does not draw from it. That is enough
 * on its own: at the app default of 20 per minute, a liveness probe at
 * `periodSeconds: 3` is exactly 20 per minute all by itself, before an
 * load-balancer health check or an uptime monitor hitting the same path from
 * the same egress address adds to it.
 *
 * `blockDuration` equals the window — explicitly since #342, by default before
 * it — so a refusal blocks the route outright for the REST OF THE WINDOW rather
 * than letting the odd request through. Not a full minute from the refusal: the
 * Lua storage caps a block at the hit key's remaining TTL, so refusing at 0:45
 * of a one-minute window refuses until 1:00, not until 1:45. Either way it is
 * consecutive probe failures, which is what crosses `failureThreshold`.
 *
 * That used to be self-limiting in a second way: the in-memory storage died
 * with the process, so a restart cleared the block outright. It does not any
 * more. Counters moved to Redis in #341 and outlive the process, so a blocked
 * probe stays blocked across the restart it causes, and the restart buys
 * nothing — the block ends when the window does, not when the pod comes back.
 * Bounded, then, at under one window rather than unrecoverable; but a window of
 * failing probes is several `periodSeconds` apart and is enough to be killed
 * again on the way out of it. `@SkipThrottle()` below is what keeps a probe
 * clear of that loop entirely; do not remove it.
 *
 * This was unreachable while the window was 60ms and became reachable when #293
 * corrected it — the throttler was never actually enforcing anything before.
 */
@SkipThrottle()
// Must stay out of the response cache: every probe is the same anonymous
// caller, and the cache stores successes but never errors, so one cached 200
// would keep answering through the outage that followed it (#528).
@ApiTags('health')
@AllowAnonymous()
@Controller('health')
export class HealthController {
  constructor(
    private readonly configService: ConfigService,
    private readonly health: HealthCheckService,
    private readonly http: HttpTargetHealthIndicator,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly cacheRedisIndicator: CacheRedisHealthIndicator,
    private readonly queueRedisIndicator: QueueRedisHealthIndicator,
    private readonly storageIndicator: StorageHealthIndicator,
  ) {}

  /**
   * K8s liveness probe target. Returns 200 as long as the Node event loop
   * can respond to HTTP. No dependency checks — liveness failure causes K8s
   * to restart the pod, which is the right response for a hung process but
   * the wrong response for a transient DB blip.
   *
   * No setting turns it off: a liveness probe that can be silenced is
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
   * Both ports answer this route, but not with the same body (#1511). The
   * public port answers its status only: a dependency's name and the message
   * its client threw name the server's internals to anyone who can reach the
   * port, and a probe reads the status code and nothing else. A request the
   * operational port accepted gets the whole Terminus report, which is what an
   * operator reads to find which dependency is down.
   */
  @HealthCheck()
  @Get('ready')
  @ApiOkResponse({
    description:
      "All critical dependencies healthy. The public port answers `{ status: 'ok' }`; the operational port answers the full report, one entry per dependency",
  })
  @ApiServiceUnavailableResponse({
    description:
      "One or more critical dependencies are unhealthy. The public port answers the error envelope with the code `NOT_READY` and `status: 'error'`; the operational port answers the full report with each failing dependency's `message`",
  })
  async ready(@Req() req: IncomingMessage): Promise<HealthCheckResult | { status: 'ok' }> {
    const report = this.health.check([
      () => this.prismaIndicator.isHealthy('database'),
      () => this.cacheRedisIndicator.isHealthy('cache'),
      () => this.queueRedisIndicator.isHealthy('queue'),
      () => this.storageIndicator?.isHealthy('storage'),
    ]);

    if (isOperationalRequest(req)) {
      return report;
    }

    try {
      await report;
      return { status: 'ok' };
    } catch (error) {
      // Only Terminus's own refusal becomes the public answer. Anything else
      // is a fault in the check itself and keeps its own handling.
      if (!(error instanceof ServiceUnavailableException)) {
        throw error;
      }

      throw new CodedHttpException(Http.ServiceUnavailable, 'NOT_READY', t('errors.health.not_ready'), {
        fields: { status: 'error' },
        cause: error,
      });
    }
  }

  /**
   * Extended health report — runs an HTTP check on each URL in
   * `HTTP_HEALTH_CHECK_URLS`.
   *
   * Intended for monitoring dashboards and on-call debugging, not K8s probes.
   * URLs are operator-configured as `name|url` pairs in the env var. A
   * failure returns 503 — operators should consume this from a monitoring
   * tool rather than a K8s readiness probe unless they explicitly want
   * external-URL availability to gate their pods.
   *
   * Empty configuration is fine, and it is the default: the indicator list is
   * empty, nothing is sent, and Terminus returns a passing result. A
   * configured HTTP check goes through the outbound HTTP policy (#1509).
   */
  @HealthCheck()
  @Get()
  @ApiOkResponse({ description: 'All HTTP checks succeeded (or none configured)' })
  @ApiServiceUnavailableResponse({ description: 'One or more HTTP checks failed' })
  detail(): Promise<HealthCheckResult> {
    return this.health.check(this.buildHttpIndicators());
  }

  /**
   * Parses `HTTP_HEALTH_CHECK_URLS` (comma-separated `name|url` entries) into
   * Terminus indicator functions. Malformed entries (anything other than
   * exactly one `|` separator producing two non-empty parts) are silently
   * dropped — better to check the well-formed entries than crash the entire
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
            this.http.check(name.trim(), url.trim()),
      );
  }
}
