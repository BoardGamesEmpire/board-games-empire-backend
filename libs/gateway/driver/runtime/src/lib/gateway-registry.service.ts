import { SystemActorScope } from '@bge/actor-context';
import { DatabaseService } from '@bge/database';
import type { GameGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import type { GatewayServiceClient } from '@boardgamesempire/proto-gateway';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FAILURE_THRESHOLD, FAILURE_WINDOW_MS } from './constants/gateway-registry.constants';
import { RemoteGatewayDriverFactory } from './drivers/remote-gateway-driver.factory';
import { GatewayDisabledEvent, type GatewayAutoDisableReason } from './events/gateway-registry.events';
import { GatewayConfigEventsService } from './gateway-config-events.service';
import { GatewayLanguageSyncService } from './gateway-language-sync.service';
import type { GatewayConfigEvent, GatewayConnectionOptions } from './interfaces';
import { hashGatewayConfig } from './utils/hash-config';

/**
 * How a cached driver entered the routing table. Config-update events from
 * Redis describe remote GameGateway rows; an in-process driver placed via
 * `register()` ('registered') has its own lifecycle and must not be torn
 * down by those events (see handleConfigUpdate). 'remote' drivers came from
 * `connect()` and do react to config changes.
 */
type DriverOrigin = 'remote' | 'registered';

interface CachedDriver {
  gatewayId: string;
  driver: GameGatewayDriver;
  configHash: string;
  origin: DriverOrigin;
}

interface FailureTrack {
  consecutiveFailures: number;
  firstFailureAt: Date;
  lastFailureAt: Date;
  lastError: string;
}

/** Max time to wait for all driver dispose() calls during shutdown. */
export const DRIVER_DISPOSE_TIMEOUT_MS = 5_000;

/**
 * Routes gateway ids to live {@link GameGatewayDriver} instances (#193).
 * Used by both the coordinator (for synchronous RPC routing) and the
 * gateway-worker (for async fetch processing).
 *
 * Transport lives behind the driver port: remote gateways resolve lazily
 * through `RemoteGatewayDriverFactory` (ping-verified gRPC), and in-process
 * drivers arrive via {@link register} — the seam #59's DataGateway plugin
 * registrations use. Everything below the port is transport-agnostic:
 * failure tracking, auto-disable, and config-event invalidation treat an
 * in-process driver exactly like a remote one.
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
  private readonly clients = new Map<string, CachedDriver>();
  private readonly failures = new Map<string, FailureTrack>();
  // In-flight lazy connects, keyed by gatewayId, so concurrent callers for the
  // same gateway share one connect attempt instead of stampeding the gateway.
  private readonly connecting = new Map<string, Promise<void>>();
  // Per-gateway invalidation counter. connect() captures this before its async
  // ping and refuses to cache the freshly-built driver if it changed meanwhile
  // — closing the race where a 'disabled'/'deleted' event arrives mid-connect,
  // finds nothing cached to tear down, and connect() then caches a driver for a
  // gateway that is no longer valid (served indefinitely until the next event).
  private readonly connectGeneration = new Map<string, number>();
  private configUpdateUnsubscribe?: () => Promise<void>;

  constructor(
    private readonly db: DatabaseService,
    private readonly remoteDriverFactory: RemoteGatewayDriverFactory,
    private readonly configEvents: GatewayConfigEventsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly systemActorScope: SystemActorScope,
    private readonly languageSync: GatewayLanguageSyncService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.configUpdateUnsubscribe = await this.configEvents.subscribe((event) => this.handleConfigUpdate(event));
  }

  async onModuleDestroy(): Promise<void> {
    await this.configUpdateUnsubscribe?.();

    // Await teardown so async dispose() work (flushing, closing handles)
    // completes — bounded by a timeout so a misbehaving driver can't hang
    // process shutdown. disposeDriver never rejects, so allSettled is
    // belt-and-suspenders; clearing the timer avoids delaying a fast exit.
    const disposals = Promise.allSettled(
      Array.from(this.clients.values()).map((cached) => this.disposeDriver(cached.gatewayId, cached.driver)),
    );

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, DRIVER_DISPOSE_TIMEOUT_MS);
    });
    await Promise.race([disposals, timeout]);
    clearTimeout(timer);

    this.clients.clear();
    this.failures.clear();
    this.connecting.clear();
    this.connectGeneration.clear();
  }

  /**
   * Establishes (or re-establishes) a connection to the specified remote
   * gateway. The factory verifies via ping before a driver exists. Existing
   * drivers are disposed and replaced. Failures during connect contribute to
   * the failure-tracking counter that can trigger auto-disable.
   */
  async connect(options: GatewayConnectionOptions): Promise<void> {
    if (this.clients.has(options.gatewayId)) {
      this.logger.log(`Replacing existing connection for gateway ${options.gatewayId}`);
      this.disconnect(options.gatewayId);
    }

    // Snapshot the invalidation counter before the async ping. If a
    // 'disabled'/'deleted' event bumps it while we await, we must discard the
    // driver we're about to cache rather than serve a now-invalid gateway.
    const generation = this.connectGeneration.get(options.gatewayId) ?? 0;

    try {
      const driver = await this.remoteDriverFactory.create(options);

      // A 'disabled'/'deleted' event may have arrived while we awaited the ping.
      // If so, this gateway must not be cached here — discard the freshly-built
      // driver instead of leaving a live connection to an invalidated gateway.
      // Return (do not throw): throwing would route through the catch below and
      // wrongly count a legitimate invalidation as a connection failure. The
      // caller (resolve) then sees no cached driver and treats the gateway as
      // unavailable, which is correct.
      if ((this.connectGeneration.get(options.gatewayId) ?? 0) !== generation) {
        this.logger.warn(`Gateway ${options.gatewayId} was invalidated while connecting; discarding the new client`);
        this.disposeDriver(options.gatewayId, driver);
        return;
      }

      this.register(options.gatewayId, driver, hashGatewayConfig(options), 'remote');

      // Language capabilities interview — fire-and-forget so connect latency
      // is unaffected. Internally throttled (daily) and never throws. The
      // driver satisfies the client parameter structurally (it IS the port).
      void this.languageSync.syncIfStale(options.gatewayId, driver);
    } catch (err) {
      await this.reportFailure(options.gatewayId, err, 'repeated_connection_failure');
      throw err;
    }
  }

  /**
   * Places a driver into the routing table under the given gateway id and
   * resets its failure history. Remote connects land here after ping
   * verification; in-process DataGateway plugin registrations (#59) call it
   * directly — from that point on, routing, failure tracking, and
   * auto-disable are identical for both.
   */
  register(gatewayId: string, driver: GameGatewayDriver, configHash = '', origin: DriverOrigin = 'registered'): void {
    // Last write wins, but never silently: a driver losing the cache slot to a
    // racing connect (eager bootstrap vs. lazy resolve for the same gateway)
    // must have its transport torn down, or its gRPC channel leaks. Skip when
    // re-registering the identical instance.
    const existing = this.clients.get(gatewayId);
    if (existing && existing.driver !== driver) {
      this.disposeDriver(gatewayId, existing.driver);
    }

    this.clients.set(gatewayId, { gatewayId, driver, configHash, origin });

    // A freshly-registered driver starts with a clean failure slate.
    this.reportSuccess(gatewayId);
  }

  /**
   * Disposes and removes the cached driver for a gateway. Safe to call
   * for unknown gatewayIds.
   */
  disconnect(gatewayId: string): void {
    const cached = this.clients.get(gatewayId);
    if (!cached) {
      // Not an error: gateways connect lazily, so an explicit disconnect RPC or
      // the auto-disable teardown legitimately targets a gateway this instance
      // never cached. Debug, not warn, to keep normal control flow quiet.
      this.logger.debug(`Attempted to disconnect gateway ${gatewayId} but no connection exists`);
      return;
    }

    this.disposeDriver(gatewayId, cached.driver);
    this.clients.delete(gatewayId);
    this.logger.log(`Gateway ${gatewayId} disconnected`);
  }

  /**
   * Best-effort driver teardown. Never throws and never rejects: dispose() is
   * `void | Promise<void>` on the port, so async teardown — e.g. a #59
   * in-process plugin closing handles — is awaited internally and its failure
   * logged rather than surfacing as an unhandledRejection. The returned
   * promise always resolves once teardown settles, so an async caller
   * (onModuleDestroy) can await it while sync callers fire-and-forget safely.
   */
  private async disposeDriver(gatewayId: string, driver: GameGatewayDriver): Promise<void> {
    try {
      await driver.dispose();
    } catch (err) {
      this.logger.warn(`Error disposing driver for ${gatewayId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Resolves a gateway's driver, lazily establishing the remote connection on
   * a cache miss by loading the gateway's config from the DB (the source of
   * truth). Concurrent callers for the same gateway share a single in-flight
   * connect, so a burst of jobs for a newly-added gateway triggers one
   * connect — not a ping stampede.
   *
   * Throws if the gateway is absent, disabled, or soft-deleted in the DB, or
   * if the connection (ping) fails. Connection failures feed the same
   * auto-disable tracking as any other failed interaction.
   */
  async resolve(gatewayId: string): Promise<GameGatewayDriver> {
    const cached = this.clients.get(gatewayId);
    if (cached) {
      return cached.driver;
    }

    await this.ensureConnected(gatewayId);

    const connected = this.clients.get(gatewayId);
    if (!connected) {
      // connect() resolved without populating the cache — defensive guard.
      throw new Error(`No connection established for gateway ${gatewayId}.`);
    }
    return connected.driver;
  }

  /**
   * @deprecated Phase-0 alias for {@link resolve} (#193). A driver IS a
   * `GatewayServiceClient` structurally, so existing call sites keep working;
   * migrate them to `resolve()` opportunistically and drop this in Phase 1.
   */
  async getServiceClient(gatewayId: string): Promise<GatewayServiceClient> {
    return this.resolve(gatewayId);
  }

  /**
   * Ensures a connection exists for the gateway, connecting from DB config if
   * not already cached. Deduplicates concurrent callers via an in-flight
   * promise so simultaneous jobs for the same gateway connect only once.
   */
  private async ensureConnected(gatewayId: string): Promise<void> {
    if (this.clients.has(gatewayId)) {
      return;
    }

    const inFlight = this.connecting.get(gatewayId);
    if (inFlight) {
      return inFlight;
    }

    const attempt = this.connectFromDb(gatewayId).finally(() => this.connecting.delete(gatewayId));
    this.connecting.set(gatewayId, attempt);
    return attempt;
  }

  /**
   * Loads an enabled, non-deleted gateway from the DB and establishes its
   * connection. Throws if the gateway no longer qualifies for connection —
   * callers should treat that as "gateway unavailable".
   */
  private async connectFromDb(gatewayId: string): Promise<void> {
    const gateway = await this.db.gameGateway.findFirst({
      where: { id: gatewayId, enabled: true, deletedAt: null },
    });

    if (!gateway) {
      throw new Error(`Gateway ${gatewayId} is not available (absent, disabled, or deleted); cannot connect.`);
    }

    this.logger.log(`Lazily connecting to gateway '${gateway.name}' (${gatewayId}) on demand`);
    await this.connect({
      gatewayId: gateway.id,
      connectionUrl: gateway.connectionUrl,
      connectionPort: gateway.connectionPort,
      authType: gateway.authType,
      authParameters: gateway.authParameters ?? undefined,
    });
  }

  /**
   * Advances the invalidation counter for a gateway. Any connect() that
   * captured an earlier value will refuse to cache its result — see the
   * generation check in {@link connect}.
   */
  private bumpConnectGeneration(gatewayId: string): void {
    this.connectGeneration.set(gatewayId, (this.connectGeneration.get(gatewayId) ?? 0) + 1);
  }

  isConnected(gatewayId: string): boolean {
    return this.clients.has(gatewayId);
  }

  connectedGatewayIds(): string[] {
    return Array.from(this.clients.keys());
  }

  /**
   * Reports a successful interaction with a gateway. Clears any in-progress
   * failure tracking. Callers should invoke this on successful calls
   * to prevent stale failures from accumulating toward the disable threshold.
   */
  reportSuccess(gatewayId: string): void {
    this.failures.delete(gatewayId);
  }

  /**
   * Reports a failed interaction with a gateway. Failures within the rolling
   * window accumulate; reaching FAILURE_THRESHOLD triggers auto-disable.
   * Callers in processors and other consumers should invoke this on failed
   * calls — the tracking is transport-agnostic, so an in-process driver
   * throwing repeatedly auto-disables exactly like a dead remote.
   *
   * The `reason` argument distinguishes connection-time failures from
   * call-time failures for the admin notification — same threshold logic,
   * different categorization.
   */
  async reportFailure(
    gatewayId: string,
    error: unknown,
    reason: GatewayAutoDisableReason = 'repeated_call_failure',
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
   *
   * Runs inside a `system` actor scope: auto-disable is system-initiated
   * failure tracking with no user in CLS, and the audit listener would flag
   * a bare emission as unattributed.
   */
  private async disableGateway(
    gatewayId: string,
    track: FailureTrack,
    reason: GatewayAutoDisableReason,
  ): Promise<void> {
    const initiatedAt = new Date();

    await this.systemActorScope.run('gateway-registry:auto-disable', async () => {
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

      // The conditional write proves enabled was true before this update.
      this.eventEmitter.emit(
        GatewayDisabledEvent.eventName,
        new GatewayDisabledEvent(
          { id: gatewayId, enabled: true },
          { id: gatewayId, enabled: false },
          {
            reason,
            consecutiveFailures: track.consecutiveFailures,
            firstFailureAt: track.firstFailureAt,
            lastFailureAt: track.lastFailureAt,
            lastError: track.lastError,
          },
          initiatedAt,
        ),
      );

      this.logger.error(
        `Gateway ${gatewayId} auto-disabled after ${track.consecutiveFailures} consecutive failures (reason=${reason}). Admin notification emitted.`,
      );
    });
  }

  /**
   * Handles incoming config-update events from other processes.
   *
   * The registry connects lazily (see resolve), so for most events the
   * correct local action is simply to drop any stale cached driver; the
   * next call re-establishes the connection from current DB config:
   *  - 'disabled' / 'deleted': invalidate unconditionally — the gateway must
   *    not be used here, and a lazy reconnect would (correctly) refuse it.
   *  - 'updated': invalidate only if the config hash actually changed.
   *  - 'created': nothing is cached yet; first use connects lazily — no-op.
   *
   * 'reconnect-requested' is the exception: it is an explicit, low-frequency
   * operator/system signal to re-establish the connection now, so we drop any
   * existing driver and eagerly reconnect rather than waiting for next use.
   */
  private async handleConfigUpdate(event: GatewayConfigEvent): Promise<void> {
    const cached = this.clients.get(event.gatewayId);

    // In-process drivers (registered via register(), e.g. #59 DataGateway
    // plugins) own their own config lifecycle. A GameGateway 'updated' or
    // 'reconnect-requested' event describes a REMOTE connection row; acting on
    // it here would disconnect the plugin driver and send the next resolve()
    // to connectFromDb, which can only build a RemoteGatewayDriver — silently
    // swapping the plugin out with no way back. Admin intent still wins:
    // 'disabled'/'deleted' fall through and tear down any origin.
    if (
      cached?.origin === 'registered' &&
      (event.changeType === 'updated' || event.changeType === 'reconnect-requested')
    ) {
      this.logger.debug(
        `Ignoring '${event.changeType}' config event for registered in-process driver ${event.gatewayId}`,
      );
      return;
    }

    // Disable / delete events invalidate regardless of hash.
    if (event.changeType === 'disabled' || event.changeType === 'deleted') {
      // Bump first, unconditionally: even with nothing cached yet, an in-flight
      // connect() may be mid-ping and about to cache a driver. Bumping the
      // generation makes that connect discard its result instead of serving a
      // disabled/deleted gateway indefinitely.
      this.bumpConnectGeneration(event.gatewayId);
      if (cached) {
        this.logger.log(`Gateway ${event.gatewayId} ${event.changeType} elsewhere; invalidating local client`);
        this.disconnect(event.gatewayId);
      }
      this.failures.delete(event.gatewayId);
      return;
    }

    // Explicit reconnect request: drop any existing driver and re-establish
    // now (regardless of hash). Eager here is safe — it's operator/system
    // initiated and low-frequency, so no ping-storm concern.
    if (event.changeType === 'reconnect-requested') {
      this.logger.log(`Reconnect requested for gateway ${event.gatewayId}; refreshing connection`);
      if (cached) {
        this.disconnect(event.gatewayId);
      }
      this.failures.delete(event.gatewayId);

      try {
        await this.ensureConnected(event.gatewayId);
      } catch (err) {
        // Don't rethrow inside the pub/sub message handler: connect() already
        // fed failure tracking, and the next call will retry lazily.
        this.logger.warn(
          `Reconnect for gateway ${event.gatewayId} failed: ${err instanceof Error ? err.message : err}`,
        );
      }
      return;
    }

    // 'created' → nothing cached yet (lazy connect handles first use), and no
    //   in-flight connect can be stale (the gateway did not exist before), so
    //   the connect generation is left untouched.
    // 'updated' → the config changed. Bump the connect generation so an
    //   in-flight connect() building the now-superseded config discards its
    //   result instead of caching it — the same mid-connect race the
    //   disabled/deleted branch guards, where nothing is cached yet but a
    //   connect may be mid-ping and about to cache a driver for the stale
    //   config (served until the next event). Skip the bump only when this
    //   process already holds the current config, where nothing stale can be
    //   in flight. Then drop any stale cached driver so the next call
    //   reconnects from current config.
    const configChanged = !cached || cached.configHash !== event.configHash;

    if (event.changeType === 'updated' && configChanged) {
      this.bumpConnectGeneration(event.gatewayId);
    }

    if (cached && configChanged) {
      this.logger.log(
        `Gateway ${event.gatewayId} config changed (hash ${cached.configHash} → ${event.configHash}); invalidating local client`,
      );
      this.disconnect(event.gatewayId);
    }
  }
}
