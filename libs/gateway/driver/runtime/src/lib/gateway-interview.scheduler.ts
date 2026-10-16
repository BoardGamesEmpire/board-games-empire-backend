import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { GatewayRegistryService } from './gateway-registry.service';

/**
 * How often the backstop checks each connected DataGateway. The check is a
 * ping; the interview itself runs only when the DataGateway reports a new
 * version, or its answers are a day old.
 */
export const INTERVIEW_BACKSTOP_TICK_MS = 60 * 60 * 1000;

/**
 * The hourly backstop for the interview (#712). A connect runs the same
 * check, but a long-lived connection may never reconnect, and a DataGateway
 * upgraded in place keeps its connection. So every tick pings each
 * DataGateway its process has connected, and interviews it again when it
 * reports a different version or its answers are a day old. Only connected
 * DataGateways are touched: no connection is made just to check.
 *
 * Uses a plain interval rather than @nestjs/schedule so it runs in every app
 * that hosts the gateway registry (coordinator, gateway-worker) without requiring
 * ScheduleModule.forRoot() — the same trade the otel queue-depth recorder
 * makes. Both processes run it: a repeated interview writes the same answers,
 * and a capability change is still recorded once.
 */
@Injectable()
export class GatewayInterviewScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayInterviewScheduler.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly registry: GatewayRegistryService) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.refresh(), INTERVIEW_BACKSTOP_TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async refresh(): Promise<void> {
    // Each DataGateway is checked on its own, so one that never answers holds
    // up no other, and isn't checked again while it still keeps one waiting.
    await Promise.all(this.registry.connectedGatewayIds().map((gatewayId) => this.check(gatewayId)));
  }

  private async check(gatewayId: string): Promise<void> {
    try {
      await this.registry.refreshInterview(gatewayId);
    } catch (err) {
      // refreshInterview never throws today. This keeps a tick from
      // rejecting unhandled if it ever does.
      this.logger.warn(
        `Interview backstop skipped DataGateway ${gatewayId}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
