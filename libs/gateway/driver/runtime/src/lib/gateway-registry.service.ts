import { SystemActorScope } from '@bge/actor-context';
import {
  DatabaseService,
  DataGatewayCapability,
  type ContentFormat,
  type ContentType,
  type CoverageAxis,
  type PlatformType,
} from '@bge/database';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import { Injectable, Logger, OnApplicationShutdown, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FAILURE_THRESHOLD, FAILURE_WINDOW_MS } from './constants/gateway-registry.constants';
import { RemoteGatewayDriverFactory } from './drivers/remote-gateway-driver.factory';
import { GatewayRoutingRefusedError, type GatewayRefusalReason } from './errors/gateway-routing-refused.error';
import { GatewayDisabledEvent, type GatewayAutoDisableReason } from './events/gateway-registry.events';
import { GatewayConfigEventsService } from './gateway-config-events.service';
import { GatewayInterviewService } from './gateway-interview.service';
import type { GatewayConfigEvent, GatewayConnectionOptions } from './interfaces';
import type { CoverageFilter } from './utils/coverage-filter';
import { hashGatewayConfig } from './utils/hash-config';

/**
 * How a cached driver entered the routing table. Config-update events from
 * Redis describe remote DataGateway rows; an in-process driver placed via
 * `register()` ('registered') has its own lifecycle and must not be torn
 * down by those events (see handleConfigUpdate). 'remote' drivers came from
 * `connect()` and do react to config changes.
 */
type DriverOrigin = 'remote' | 'registered';

interface CachedDriver {
  gatewayId: string;
  driver: DataGatewayDriver;
  configHash: string;
  origin: DriverOrigin;
}

interface FailureTrack {
  consecutiveFailures: number;
  firstFailureAt: Date;
  lastFailureAt: Date;
  lastError: string;
}

/** What a routing decision reads from a DataGateway's row. */
interface RoutingRow {
  enabled: boolean;
  firstInterviewedAt: Date | null;
  capabilities: DataGatewayCapability[];
  disabledCapabilities: DataGatewayCapability[];
  coveragePlatformTypes: PlatformType[];
  coverageContentTypes: ContentType[];
  filterableAxes: CoverageAxis[];
  contentFormat: ContentFormat | null;
}

const ROUTING_FIELDS = {
  enabled: true,
  firstInterviewedAt: true,
  capabilities: true,
  disabledCapabilities: true,
  coveragePlatformTypes: true,
  coverageContentTypes: true,
  filterableAxes: true,
  contentFormat: true,
} as const;

/** A DataGateway's coverage, as its row stores it. */
export type StoredCoverage = Pick<RoutingRow, 'coveragePlatformTypes' | 'coverageContentTypes'>;

/**
 * How a search reaches one DataGateway now, by its row. One that may not
 * search is left to {@link GatewayRegistryService.resolveSearch}, which
 * refuses it, saying why, or interviews it first when it never was.
 */
export type SearchRoute =
  | { readonly routable: false }
  | {
      readonly routable: true;

      /** Whether its coverage overlaps the search's filter. One that doesn't isn't asked. */
      readonly covers: boolean;

      /** The coverage axes its search narrows by. The filter it's sent carries only these. */
      readonly filterableAxes: readonly CoverageAxis[];

      /** The content format its results' summaries arrive in, null when it declared none. */
      readonly contentFormat: ContentFormat | null;

      /**
       * Its driver, connecting it first if this process hasn't, for a search
       * that must ask it after all. Its row isn't read again.
       */
      readonly driver: () => Promise<DataGatewayDriver>;
    };

/**
 * A DataGateway resolved for one operation, with the content format its free
 * text arrives in, null when it declared none.
 */
export interface GatewayResolution {
  readonly driver: DataGatewayDriver;
  readonly contentFormat: ContentFormat | null;
}

/** A DataGateway a search will ask, and the coverage axes its search narrows by. */
export interface SearchResolution extends GatewayResolution {
  readonly filterableAxes: readonly CoverageAxis[];
}

/**
 * The routing rule, the one place it's written: why a DataGateway may not
 * serve `capability` now, or null when it may. `row` is its routing row,
 * null when it's absent or deleted. Without a capability, only whether the
 * DataGateway may be used at all.
 */
function routingRefusal(row: RoutingRow | null, capability?: DataGatewayCapability): GatewayRefusalReason | null {
  if (!row) {
    return 'unknown';
  }

  if (!row.enabled) {
    return 'disabled';
  }

  if (capability === undefined) {
    return null;
  }

  if (!row.firstInterviewedAt) {
    return 'not_interviewed';
  }

  if (!row.capabilities.includes(capability)) {
    return 'not_declared';
  }

  if (row.disabledCapabilities.includes(capability)) {
    return 'switched_off';
  }

  return null;
}

/**
 * The coverage rule for a search, beside the routing rule: whether a
 * DataGateway's coverage overlaps the search's filter. It does when, on each
 * axis the filter names, it covers a value named there (#713). Coverage empty
 * on an axis covers nothing on it, so overlaps no filter that names it.
 */
export function coverageOverlaps(coverage: StoredCoverage, filter: CoverageFilter): boolean {
  const covers = <T>(covered: readonly T[], named: ReadonlySet<T> | undefined): boolean =>
    named === undefined || covered.some((value) => named.has(value));

  return (
    covers(coverage.coveragePlatformTypes, filter.platformTypes) &&
    covers(coverage.coverageContentTypes, filter.contentTypes)
  );
}

/** Max time to wait for all driver dispose() calls during shutdown. */
export const DRIVER_DISPOSE_TIMEOUT_MS = 5_000;

/**
 * Routes gateway ids to live {@link DataGatewayDriver} instances (#193).
 * Used by both the coordinator (for synchronous RPC routing) and the
 * gateway-worker (for async fetch processing).
 *
 * Transport lives behind the driver port: remote gateways resolve lazily
 * through `RemoteGatewayDriverFactory` (ping-verified gRPC), and in-process
 * drivers arrive via {@link register} — the seam #59's DataGateway plugin
 * registrations use. Everything below the port is transport-agnostic:
 * the interview, failure tracking, auto-disable, and config-event
 * invalidation treat an in-process driver exactly like a remote one.
 *
 * A DataGateway is routed only by its answers to the interview (#712). Its
 * first interview runs before its driver is cached, whichever way the driver
 * arrived, and a DataGateway whose first interview fails is neither cached
 * nor routed. Every routing decision then reads the DataGateway's row, so
 * both processes route by the answers whichever of them interviewed, and by
 * an admin's latest word on `enabled` and on the capabilities switched off
 * ({@link resolve}, {@link routableGatewayIds}).
 *
 * State authority for DataGateway rows lives in the coordinator. Other
 * processes treat this service as a read-side: they react to config-update
 * events via Redis pub/sub, but never mutate gateway state except for
 * auto-disable triggered by their own repeated-failure observations, and the
 * answers of the interviews they run.
 *
 * Failure tracking is per-process and in-memory. When N consecutive failures
 * accumulate within a time window, this service disables the gateway in the
 * DB and emits an event, which the audit log records. The DB update uses
 * conditional write so concurrent disables across processes only emit once.
 * Telling server admins is #763's.
 */
@Injectable()
export class GatewayRegistryService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
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
  // DataGateways whose connection config changed since this process cached a
  // driver for them. Their stored answers came through the old connection,
  // so the next connect interviews them again, whatever the answers' age and
  // version. Held in memory: a process that missed the change goes by the
  // version and the answers' age, as before.
  private readonly connectionChanged = new Set<string>();
  // Set once shutdown disposes the drivers. A connect still awaiting its ping
  // then discards its driver rather than caching one nothing will dispose.
  private shuttingDown = false;
  private configUpdateUnsubscribe?: () => Promise<void>;

  constructor(
    private readonly db: DatabaseService,
    private readonly remoteDriverFactory: RemoteGatewayDriverFactory,
    private readonly configEvents: GatewayConfigEventsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly systemActorScope: SystemActorScope,
    private readonly interviews: GatewayInterviewService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.configUpdateUnsubscribe = await this.configEvents.subscribe((event) => this.handleConfigUpdate(event));
  }

  async onModuleDestroy(): Promise<void> {
    await this.configUpdateUnsubscribe?.();
  }

  // Not onModuleDestroy: the server still takes requests then, and a search in
  // that window would find its gateway's driver already disposed (#673).
  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;

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
    this.connectionChanged.clear();
  }

  /**
   * Establishes (or re-establishes) a connection to the specified remote
   * DataGateway. The factory verifies via ping before a driver exists, and the
   * driver is cached only once the DataGateway has passed its first
   * interview ({@link register}). Existing drivers are disposed and replaced.
   * Failures to connect contribute to the failure-tracking counter that can
   * trigger auto-disable; a failed interview doesn't.
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

    let driver: DataGatewayDriver;
    try {
      driver = await this.remoteDriverFactory.create(options);
    } catch (err) {
      await this.reportFailure(options.gatewayId, err, 'repeated_connection_failure');
      throw err;
    }

    await this.interviewAndCache(
      { gatewayId: options.gatewayId, driver, configHash: hashGatewayConfig(options), origin: 'remote' },
      generation,
    );
  }

  /**
   * Places an in-process driver into the routing table under the given
   * gateway id and resets its failure history: the seam DataGateway plugin
   * registrations (#59) will call. connect() caches a remote driver the same
   * way after its ping, and from then on the interview, routing, failure
   * tracking, and auto-disable are identical for both.
   *
   * A DataGateway never interviewed is interviewed first, and its driver is
   * cached only if that succeeds. Otherwise the driver is disposed and this
   * throws, so nothing is routed. A remote DataGateway is connected and
   * interviewed again when next reached, but the gateway registry can't
   * rebuild a driver handed in here: whoever handed it in registers it again.
   */
  async register(
    gatewayId: string,
    driver: DataGatewayDriver,
    configHash = '',
    origin: DriverOrigin = 'registered',
  ): Promise<void> {
    await this.interviewAndCache({ gatewayId, driver, configHash, origin }, this.connectGeneration.get(gatewayId) ?? 0);
  }

  /**
   * Caches a driver once its DataGateway has passed its first interview,
   * unless the DataGateway was invalidated meanwhile. `generation` is the
   * invalidation counter from before the driver was built.
   */
  private async interviewAndCache(entry: CachedDriver, generation: number): Promise<void> {
    const { gatewayId, driver } = entry;

    if (this.discardIfInvalidated(gatewayId, driver, generation)) {
      return;
    }

    // Outside connect()'s failure tracking on purpose: the DataGateway
    // answered its ping, so it isn't down, and re-enabling it couldn't fix an
    // interview. The interview records the failure on the row.
    let interviewedNow: boolean;
    try {
      interviewedNow = await this.interviews.interviewUnlessDone(gatewayId, driver);
    } catch (err) {
      // An invalidation abandons the interview: that's a discard, as during the ping.
      if (this.discardIfInvalidated(gatewayId, driver, generation)) {
        return;
      }

      void this.disposeDriver(gatewayId, driver);
      throw err;
    }

    // The interview is a second wait in which the DataGateway may be invalidated.
    if (this.discardIfInvalidated(gatewayId, driver, generation)) {
      return;
    }

    // Last write wins, but never silently: a driver losing the cache slot to a
    // racing connect (eager bootstrap vs. lazy resolve for the same gateway)
    // must have its transport torn down, or its gRPC channel leaks. Skip when
    // re-registering the identical instance.
    const existing = this.clients.get(gatewayId);
    if (existing && existing.driver !== driver) {
      void this.disposeDriver(gatewayId, existing.driver);
    }

    this.clients.set(gatewayId, entry);

    // A freshly-registered driver starts with a clean failure slate.
    this.reportSuccess(gatewayId);

    // Answers from an earlier connect, perhaps another process's, may have
    // gone stale: interview again in the background if the connection
    // changed since, the DataGateway reports a new version, or its answers
    // are a day old. It keeps its last good answers meanwhile.
    const connectionChanged = this.connectionChanged.delete(gatewayId);
    if (!interviewedNow) {
      void this.interviews.refreshIfStale(gatewayId, driver, connectionChanged);
    }
  }

  /**
   * Disposes a driver that mustn't be cached: a 'disabled'/'deleted' or
   * config-change event arrived while it was connecting or being
   * interviewed, or shutdown already disposed the cached drivers. Returns
   * true rather than throwing, so the invalidation isn't counted as a
   * connection failure; the caller (resolve) then finds no cached driver and
   * treats the DataGateway as unavailable, which is correct.
   */
  private discardIfInvalidated(gatewayId: string, driver: DataGatewayDriver, generation: number): boolean {
    if ((this.connectGeneration.get(gatewayId) ?? 0) !== generation) {
      this.logger.warn(
        `DataGateway ${gatewayId} was invalidated while connecting or being interviewed; discarding the new driver`,
      );
      void this.disposeDriver(gatewayId, driver);
      return true;
    }

    // Shutdown already disposed the cached drivers and won't run again.
    if (this.shuttingDown) {
      void this.disposeDriver(gatewayId, driver);
      return true;
    }

    return false;
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
   * (onApplicationShutdown) can await it while sync callers fire-and-forget safely.
   */
  private async disposeDriver(gatewayId: string, driver: DataGatewayDriver): Promise<void> {
    try {
      // An interview asking through the driver would otherwise wait on, or
      // record a failure of, the connection closed under it.
      this.interviews.abandon(gatewayId, driver);
      await driver.dispose();
    } catch (err) {
      this.logger.warn(`Error disposing driver for ${gatewayId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Resolves a DataGateway's driver for one operation, the capability that
   * names it. Reads the DataGateway's row first, and refuses, with a
   * {@link GatewayRoutingRefusedError}, a DataGateway that's absent, deleted
   * or disabled, one whose first interview hasn't succeeded, and a capability
   * it doesn't declare or that an admin switched off. A refusal holds even
   * while this process caches the driver, and never counts toward
   * auto-disable.
   *
   * On a cache miss the remote connection is established lazily from the
   * DB config (the source of truth), and concurrent callers for the same
   * DataGateway share a single in-flight connect, so a burst of jobs for a
   * newly added DataGateway triggers one connect — not a ping stampede.
   * Reaching a DataGateway never interviewed connects it, which interviews
   * it, before the capability is checked.
   *
   * Also throws when the connection (ping) or the first interview fails.
   * Connection failures feed the same auto-disable tracking as any other
   * failed interaction.
   */
  async resolve(gatewayId: string, capability: DataGatewayCapability): Promise<DataGatewayDriver> {
    return (await this.resolveWithContentFormat(gatewayId, capability)).driver;
  }

  /**
   * {@link resolve}, with the content format the DataGateway's free text
   * arrives in, from the same read of its row: for a caller that converts
   * that text, as a search's results' summaries are.
   */
  async resolveWithContentFormat(gatewayId: string, capability: DataGatewayCapability): Promise<GatewayResolution> {
    const row = await this.routedRow(gatewayId, capability);

    return { driver: await this.driverFor(gatewayId), contentFormat: row.contentFormat };
  }

  /**
   * {@link resolve} for a search narrowed by `filter`: the driver, with the
   * coverage axes its search narrows by, or null when its coverage doesn't
   * overlap the filter, so it needn't be asked. Refuses as resolve does, and
   * first, so a DataGateway that may not search says why whatever its
   * coverage. One never interviewed is interviewed before its coverage is
   * read, since its coverage isn't known until then.
   */
  async resolveSearch(gatewayId: string, filter: CoverageFilter): Promise<SearchResolution | null> {
    const row = await this.routedRow(gatewayId, DataGatewayCapability.Search);

    if (!coverageOverlaps(row, filter)) {
      return null;
    }

    return {
      driver: await this.driverFor(gatewayId),
      filterableAxes: row.filterableAxes,
      contentFormat: row.contentFormat,
    };
  }

  /**
   * How a search narrowed by `filter` reaches the DataGateway now, by one
   * read of its row, without connecting it: for a caller that may answer
   * without the driver, such as a search served from its cache, or one the
   * DataGateway's coverage can't match. One that must ask it after all takes
   * the route's driver.
   */
  async searchRoute(gatewayId: string, filter: CoverageFilter): Promise<SearchRoute> {
    const row = await this.routingRow(gatewayId);

    if (!row || routingRefusal(row, DataGatewayCapability.Search)) {
      return { routable: false };
    }

    return {
      routable: true,
      covers: coverageOverlaps(row, filter),
      filterableAxes: row.filterableAxes,
      contentFormat: row.contentFormat,
      driver: () => this.driverFor(gatewayId),
    };
  }

  /**
   * The DataGateways this process has connected that may serve the
   * capability now: enabled, past their first interview, declaring it, and
   * without an admin's switch-off. A search that names no DataGateway goes
   * to these; one this process hasn't connected yet isn't reached that way
   * (#722). A search narrowed by `filter` goes only to those whose coverage
   * overlaps it.
   */
  async routableGatewayIds(capability: DataGatewayCapability, filter: CoverageFilter = {}): Promise<string[]> {
    const connected = this.connectedGatewayIds();
    if (connected.length === 0) {
      return [];
    }

    const rows = await this.db.dataGateway.findMany({
      where: { id: { in: connected }, deletedAt: null },
      select: { id: true, ...ROUTING_FIELDS },
    });

    const routable = new Set(
      rows
        .filter((row) => routingRefusal(row, capability) === null && coverageOverlaps(row, filter))
        .map((row) => row.id),
    );
    return connected.filter((gatewayId) => routable.has(gatewayId));
  }

  /**
   * Interviews a DataGateway now, however recent its answers: for an admin
   * who asks (#715 adds the route). Connects it first if this process hasn't,
   * and for a DataGateway never interviewed, that connect is the interview.
   * Throws when it's absent, deleted or disabled, or when the interview
   * fails, which the row records.
   */
  async reinterview(gatewayId: string): Promise<void> {
    const row = await this.routingRow(gatewayId);
    const refusal = routingRefusal(row);
    if (refusal) {
      throw new GatewayRoutingRefusedError(gatewayId, refusal);
    }

    // Connecting a DataGateway never interviewed interviews it. A config
    // change abandons that connect without throwing, and then no interview
    // happened: say so rather than answer as if one had (#715).
    if (!row?.firstInterviewedAt && !this.clients.has(gatewayId)) {
      await this.ensureConnected(gatewayId);
      if (!this.clients.has(gatewayId)) {
        throw new Error(`DataGateway ${gatewayId}'s interview was abandoned: its connect was invalidated`);
      }
      return;
    }

    await this.interviews.interview(gatewayId, await this.driverFor(gatewayId));
  }

  /**
   * Interviews a DataGateway this process has connected again if its answers
   * have gone stale: the hourly backstop's job. Never throws.
   */
  async refreshInterview(gatewayId: string): Promise<void> {
    const cached = this.clients.get(gatewayId);
    if (cached) {
      await this.interviews.refreshIfStale(gatewayId, cached.driver);
    }
  }

  /**
   * The row of a DataGateway that may serve the capability now, connecting
   * and so interviewing it first when it never was. Throws a
   * {@link GatewayRoutingRefusedError} when it may not.
   */
  private async routedRow(gatewayId: string, capability: DataGatewayCapability): Promise<RoutingRow> {
    let row = await this.routingRow(gatewayId);

    if (row?.enabled && !row.firstInterviewedAt) {
      await this.ensureConnected(gatewayId);
      row = await this.routingRow(gatewayId);
    }

    const refusal = routingRefusal(row, capability);
    if (refusal) {
      throw new GatewayRoutingRefusedError(gatewayId, refusal, capability);
    }

    // routingRefusal refuses an absent row, so there is one.
    return row as RoutingRow;
  }

  private routingRow(gatewayId: string): Promise<RoutingRow | null> {
    return this.db.dataGateway.findFirst({
      where: { id: gatewayId, deletedAt: null },
      select: ROUTING_FIELDS,
    });
  }

  /** The cached driver, or one connected lazily from the DB config. */
  private async driverFor(gatewayId: string): Promise<DataGatewayDriver> {
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
    const gateway = await this.db.dataGateway.findFirst({
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
    // An interview under way asks through a driver from before the bump.
    this.interviews.abandon(gatewayId);
  }

  isConnected(gatewayId: string): boolean {
    return this.clients.has(gatewayId);
  }

  /**
   * The DataGateways this process holds a driver for. Holding one says
   * nothing about whether it may be routed: see {@link routableGatewayIds}.
   */
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
      const result = await this.db.dataGateway.updateMany({
        where: { id: gatewayId, enabled: true },
        data: { enabled: false },
      });

      // Always tear down locally — regardless of whether this process won the
      // write race, the gateway should not be used here anymore.
      this.disconnect(gatewayId);
      this.failures.delete(gatewayId);

      if (result.count === 0) {
        this.logger.warn(
          `DataGateway ${gatewayId} was already off (another process auto-disabled it, or a server admin switched it off); emitting nothing.`,
        );
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
        `DataGateway ${gatewayId} auto-disabled after ${track.consecutiveFailures} consecutive failures (reason=${reason}).`,
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
    // plugins) own their own config lifecycle. A DataGateway 'updated' or
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
    //   reconnects from current config, and interviews the DataGateway it
    //   reaches there.
    const configChanged = !cached || cached.configHash !== event.configHash;

    if (event.changeType === 'updated' && configChanged) {
      this.bumpConnectGeneration(event.gatewayId);
      this.connectionChanged.add(event.gatewayId);
    }

    if (cached && configChanged) {
      this.logger.log(
        `Gateway ${event.gatewayId} config changed (hash ${cached.configHash} → ${event.configHash}); invalidating local client`,
      );
      this.disconnect(event.gatewayId);
    }
  }
}
