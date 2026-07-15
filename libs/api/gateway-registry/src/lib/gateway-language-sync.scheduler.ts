import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { GatewayLanguageSyncService } from './gateway-language-sync.service';
import { GatewayRegistryService } from './gateway-registry.service';

/**
 * Hourly tick; the actual re-interview is gated by syncIfStale's daily
 * throttle (GameGateway.languagesSyncedAt), so this only determines how
 * promptly a stale gateway is noticed — not how often it is interviewed.
 */
export const LANGUAGE_SYNC_TICK_MS = 60 * 60 * 1000;

/**
 * Periodic freshness backstop for gateway language links (issue #38's
 * "scheduled sync job"). The primary trigger is connect-time (see
 * GatewayRegistryService.connect); this scheduler covers long-lived
 * connections that never reconnect and would otherwise never re-interview.
 *
 * Uses a plain interval rather than @nestjs/schedule so it runs in every app
 * that hosts the registry (coordinator, gateway-worker) without requiring
 * ScheduleModule.forRoot() — the same trade the otel queue-depth recorder
 * makes. Only already-connected gateways are touched: no connections are
 * initiated just to interview.
 */
@Injectable()
export class GatewayLanguageSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayLanguageSyncScheduler.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly registry: GatewayRegistryService,
    private readonly languageSync: GatewayLanguageSyncService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.refresh(), LANGUAGE_SYNC_TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async refresh(): Promise<void> {
    for (const gatewayId of this.registry.connectedGatewayIds()) {
      try {
        const client = await this.registry.getServiceClient(gatewayId);
        await this.languageSync.syncIfStale(gatewayId, client);
      } catch (err) {
        // syncIfStale never throws; this guards getServiceClient (a gateway
        // disabled/deleted between listing and resolution).
        this.logger.warn(
          `Language sync tick skipped gateway ${gatewayId}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }
}
