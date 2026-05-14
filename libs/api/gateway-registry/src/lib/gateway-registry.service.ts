import { DatabaseService } from '@bge/database';
import { pingWithRetry, walkDir } from '@bge/utils';
import { GatewayServiceClient, PROTO_PACKAGE_NAME } from '@board-games-empire/proto-gateway';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClientGrpcProxy, ClientProxyFactory, Transport } from '@nestjs/microservices';
import * as path from 'node:path';
import { FAILURE_THRESHOLD, FAILURE_WINDOW_MS, GATEWAY_DISABLED_EVENT } from './constants/gateway-registry.constants';
import { GatewayCredentialsFactory } from './credentials/gateway-credentials.factory';
import { GatewayConfigEventsService } from './gateway-config-events.service';
import type { GatewayConfigEvent, GatewayConnectionOptions, GatewayDisabledEvent } from './interfaces';
import { hashGatewayConfig } from './utils/hash-config';

interface CachedClient {
  gatewayId: string;
  proxy: ClientGrpcProxy;
  configHash: string;
}

interface FailureTrack {
  consecutiveFailures: number;
  firstFailureAt: Date;
  lastFailureAt: Date;
  lastError: string;
}

/**
 * Manages gRPC client lifecycle for gateway connections. Used by both the
 * coordinator (for synchronous RPC routing) and the gateway-worker (for
 * async fetch processing).
 *
 * State authority for GameGateway rows lives in the coordinator. Other
 * processes treat this service as a read-side: they react to config-update
 * events via Redis pub/sub, but never mutate gateway state except for
 * auto-disable triggered by their own repeated-failure observations.
 *
 * Failure tracking is per-process and in-memory. When N consecutive failures
 * accumulate within a time window, this service disables the gateway in the
 * DB and emits an event for admin notification. The DB update uses
 * conditional write so concurrent disables across processes only fire one
 * notification.
 */
@Injectable()
export class GatewayRegistryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GatewayRegistryService.name);
  private readonly clients = new Map<string, CachedClient>();
  private readonly failures = new Map<string, FailureTrack>();
  private configUpdateUnsubscribe?: () => Promise<void>;

  constructor(
    private readonly db: DatabaseService,
    private readonly credentialsFactory: GatewayCredentialsFactory,
    private readonly configEvents: GatewayConfigEventsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit(): Promise<void> {
    this.configUpdateUnsubscribe = await this.configEvents.subscribe((event) => this.handleConfigUpdate(event));
  }

  async onModuleDestroy(): Promise<void> {
    await this.configUpdateUnsubscribe?.();

    for (const cached of this.clients.values()) {
      try {
        cached.proxy.close();
      } catch (err) {
        this.logger.warn(`Error closing client for ${cached.gatewayId}: ${err instanceof Error ? err.message : err}`);
      }
    }
    this.clients.clear();
    this.failures.clear();
  }

  /**
   * Establishes (or re-establishes) a connection to the specified gateway.
   * Verifies via ping before storing. Existing connections are closed and
   * replaced. Failures during connect contribute to the failure-tracking
   * counter that can trigger auto-disable.
   */
  async connect(options: GatewayConnectionOptions): Promise<void> {
    const url = `${options.connectionUrl}:${options.connectionPort}`;

    if (this.clients.has(options.gatewayId)) {
      this.logger.log(`Replacing existing connection for gateway ${options.gatewayId}`);
      this.disconnect(options.gatewayId);
    }

    this.logger.log(`Connecting to gateway ${options.gatewayId} at ${url} with auth type ${options.authType}`);
    const protoPaths = walkDir(path.join(__dirname, 'proto'), /\.proto$/, [/(^|[/\\])coordinator([/\\]|$)/]);

    try {
      const channelCredentials = this.credentialsFactory.create(options.authType, options.authParameters);
      const proxy = ClientProxyFactory.create({
        transport: Transport.GRPC,
        options: {
          url,
          package: PROTO_PACKAGE_NAME,
          protoPath: protoPaths,
          loader: {
            includeDirs: [path.join(__dirname, 'proto')],
            arrays: true,
            longs: String,
            enums: String,
          },
          credentials: channelCredentials,
        },
      }) as ClientGrpcProxy;

      const gatewayServiceClient = proxy.getService<GatewayServiceClient>('GatewayService');
      const response = await pingWithRetry(gatewayServiceClient, options.gatewayId, this.logger);

      this.logger.log(
        `Successfully connected to gateway ${options.gatewayId} at ${url}. Response: ${JSON.stringify(response)}`,
      );

      this.clients.set(options.gatewayId, {
        gatewayId: options.gatewayId,
        proxy,
        configHash: hashGatewayConfig(options),
      });

      // Successful connect resets failure history.
      this.reportSuccess(options.gatewayId);
    } catch (err) {
      await this.reportFailure(options.gatewayId, err, 'repeated_connection_failure');
      throw err;
    }
  }

  /**
   * Disconnects and removes the cached client for a gateway. Safe to call
   * for unknown gatewayIds.
   */
  disconnect(gatewayId: string): void {
    const cached = this.clients.get(gatewayId);
    if (!cached) {
      this.logger.warn(`Attempted to disconnect gateway ${gatewayId} but no connection exists`);
      return;
    }

    try {
      cached.proxy.close();
    } catch (err) {
      this.logger.warn(`Error closing client for ${gatewayId}: ${err instanceof Error ? err.message : err}`);
    }
    this.clients.delete(gatewayId);
    this.logger.log(`Gateway ${gatewayId} disconnected`);
  }

  get(gatewayId: string): ClientGrpcProxy {
    const cached = this.clients.get(gatewayId);
    if (!cached) {
      throw new Error(`No connection found for gateway ${gatewayId}. Ensure it is enabled and connected.`);
    }
    return cached.proxy;
  }

  getServiceClient(gatewayId: string): GatewayServiceClient {
    return this.get(gatewayId).getService<GatewayServiceClient>('GatewayService');
  }

  isConnected(gatewayId: string): boolean {
    return this.clients.has(gatewayId);
  }

  connectedGatewayIds(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Reports a successful interaction with a gateway. Clears any in-progress
   * failure tracking. Callers should invoke this on successful gRPC calls
   * to prevent stale failures from accumulating toward the disable threshold.
   */
  reportSuccess(gatewayId: string): void {
    this.failures.delete(gatewayId);
  }

  /**
   * Reports a failed interaction with a gateway. Failures within the rolling
   * window accumulate; reaching FAILURE_THRESHOLD triggers auto-disable.
   * Callers in processors and other consumers should invoke this on failed
   * gRPC calls.
   *
   * The `reason` argument distinguishes connection-time failures from
   * call-time failures for the admin notification — same threshold logic,
   * different categorization.
   */
  async reportFailure(
    gatewayId: string,
    error: unknown,
    reason: GatewayDisabledEvent['reason'] = 'repeated_call_failure',
  ): Promise<void> {
    const now = new Date();
    const errorMessage = error instanceof Error ? error.message : String(error);
    const existing = this.failures.get(gatewayId);

    // Outside window → start fresh tracking.
    const outsideWindow = existing && now.getTime() - existing.firstFailureAt.getTime() > FAILURE_WINDOW_MS;

    const track: FailureTrack =
      !existing || outsideWindow
        ? { consecutiveFailures: 1, firstFailureAt: now, lastFailureAt: now, lastError: errorMessage }
        : {
            consecutiveFailures: existing.consecutiveFailures + 1,
            firstFailureAt: existing.firstFailureAt,
            lastFailureAt: now,
            lastError: errorMessage,
          };

    this.failures.set(gatewayId, track);

    this.logger.warn(`Gateway ${gatewayId} failure ${track.consecutiveFailures}/${FAILURE_THRESHOLD}: ${errorMessage}`);

    if (track.consecutiveFailures >= FAILURE_THRESHOLD) {
      await this.disableGateway(gatewayId, track, reason);
    }
  }

  /**
   * Disables a gateway in the DB, publishes a config-update event, and
   * emits an in-process domain event for notification listeners.
   *
   * Race-safe: the DB update is conditional on enabled=true, so when
   * multiple processes hit the threshold concurrently only the first
   * succeeded write fires the notification.
   */
  private async disableGateway(
    gatewayId: string,
    track: FailureTrack,
    reason: GatewayDisabledEvent['reason'],
  ): Promise<void> {
    const result = await this.db.gameGateway.updateMany({
      where: { id: gatewayId, enabled: true },
      data: { enabled: false },
    });

    // Always tear down locally — regardless of whether this process won the
    // write race, the gateway should not be used here anymore.
    this.disconnect(gatewayId);
    this.failures.delete(gatewayId);

    if (result.count === 0) {
      this.logger.warn(`Gateway ${gatewayId} was already disabled by another process; skipping notification`);
      return;
    }

    // We won the race — publish for other processes and emit notification.
    const event: GatewayConfigEvent = {
      gatewayId,
      configHash: '',
      changeType: 'disabled',
      timestamp: Date.now(),
    };
    await this.configEvents.publish(event);

    const disabledEvent: GatewayDisabledEvent = {
      gatewayId,
      reason,
      consecutiveFailures: track.consecutiveFailures,
      firstFailureAt: track.firstFailureAt,
      lastFailureAt: track.lastFailureAt,
      lastError: track.lastError,
    };
    this.eventEmitter.emit(GATEWAY_DISABLED_EVENT, disabledEvent);

    this.logger.error(
      `Gateway ${gatewayId} auto-disabled after ${track.consecutiveFailures} consecutive failures (reason=${reason}). Admin notification emitted.`,
    );
  }

  /**
   * Handles incoming config-update events from other processes. Invalidates
   * cached client if config has changed; doesn't reconnect — next getClient
   * call triggers reconnect on demand.
   */
  private async handleConfigUpdate(event: GatewayConfigEvent): Promise<void> {
    const cached = this.clients.get(event.gatewayId);

    // Disable / delete events invalidate regardless of hash.
    if (event.changeType === 'disabled' || event.changeType === 'deleted') {
      if (cached) {
        this.logger.log(`Gateway ${event.gatewayId} ${event.changeType} elsewhere; invalidating local client`);
        this.disconnect(event.gatewayId);
      }
      this.failures.delete(event.gatewayId);
      return;
    }

    // Updates only invalidate if config actually changed.
    if (cached && cached.configHash !== event.configHash) {
      this.logger.log(
        `Gateway ${event.gatewayId} config changed (hash ${cached.configHash} → ${event.configHash}); invalidating local client`,
      );
      this.disconnect(event.gatewayId);
    }
  }
}
