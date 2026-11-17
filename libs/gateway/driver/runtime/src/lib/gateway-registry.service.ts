import { SystemActorScope } from '@bge/actor-context';
import {
  DatabaseService,
  DataGatewayCapability,
  PluginCategory,
  type ContentFormat,
  type ContentType,
  type PlatformType,
  type SearchFilterAxis,
} from '@bge/database';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { FAILURE_THRESHOLD, FAILURE_WINDOW_MS } from './constants/gateway-registry.constants';
import { RemoteGatewayDriverFactory } from './drivers/remote-gateway-driver.factory';
import { GatewayRoutingRefusedError, type GatewayRefusalReason } from './errors/gateway-routing-refused.error';
import { GatewayDisabledEvent, type GatewayAutoDisableReason } from './events/gateway-registry.events';
import { GatewayConfigEventsService } from './gateway-config-events.service';
import { GatewayInterviewService } from './gateway-interview.service';
import type { GatewayConfigEvent, GatewayConnectionOptions } from './interfaces';
import {
  PLUGIN_DRIVER_SOURCE,
  ROUTED_PLUGIN_FIELDS,
  type PluginDriverSource,
  type RoutedPlugin,
} from './plugin-driver-source';
import type { CoverageFilter } from './utils/coverage-filter';
import { hashGatewayConfig } from './utils/hash-config';
import { remoteConnectionOptions } from './utils/remote-connection-options';

/**
 * How a cached driver entered the routing table, which decides what a
 * config-update event from Redis does to it (see handleConfigUpdate):
 * - 'remote': `connect()` built it from a remote DataGateway's connection
 *   fields, so it reacts to every change of them.
 * - 'plugin': the plugin driver source built it for a plugin DataGateway
 *   (#1083). No connection fields went into it, and the registry can build
 *   it again.
 * - 'registered': it was handed in whole to `register()`. The registry
 *   can't rebuild it, so only 'disabled' and 'deleted' take it down.
 */
type DriverOrigin = 'remote' | 'registered' | 'plugin';

interface CachedDriver {
  gatewayId: string;
  driver: DataGatewayDriver;
  configHash: string;
  origin: DriverOrigin;

  /**
   * For a driver the plugin driver source built, the install of the plugin
   * it was built from: its `installedAt`, which a reinstall rewrites (#1083).
   */
  installedAt?: Date;
}

interface FailureTrack {
  consecutiveFailures: number;
  firstFailureAt: Date;
  lastFailureAt: Date;
  lastError: string;
}

/**
 * What a routing decision reads from a DataGateway's row, and, for a plugin
 * DataGateway, of its plugin beside it (#1083).
 */
interface RoutingRow {
  enabled: boolean;
  pluginId: string | null;
  plugin: RoutedPlugin | null;
  firstInterviewedAt: Date | null;
  capabilities: DataGatewayCapability[];
  disabledCapabilities: DataGatewayCapability[];
  coveragePlatformTypes: PlatformType[];
  coverageContentTypes: ContentType[];
  filterableAxes: SearchFilterAxis[];
  contentFormat: ContentFormat | null;
}

const ROUTING_FIELDS = {
  enabled: true,
  pluginId: true,
  plugin: { select: ROUTED_PLUGIN_FIELDS },
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

      /** The search filters its search narrows by. The filter it's sent carries only these. */
      readonly filterableAxes: readonly SearchFilterAxis[];

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

/** A DataGateway a search will ask, and the search filters its search narrows by. */
export interface SearchResolution extends GatewayResolution {
  readonly filterableAxes: readonly SearchFilterAxis[];
}

/**
 * Whether the server serves a plugin DataGateway's plugin: still a
 * data-gateway plugin, switched on, installed, and not quarantined by a failed
 * load (#1083). An update can move a plugin to another category, and the row
 * it leaves behind is then no plugin's to serve.
 */
const isServed = (plugin: RoutedPlugin): boolean =>
  plugin.category === PluginCategory.DataGateway &&
  plugin.enabled &&
  plugin.uninstalledAt === null &&
  !plugin.loadFailed;

/**
 * The routing rule, the one place it's written: why a DataGateway may not
 * serve `capability` now, or null when it may. `row` is its routing row,
 * null when it's absent or deleted. Without a capability, only whether the
 * DataGateway may be used at all.
 *
 * It goes by the row alone, with the plugin read beside it. Whether this
 * process has a plugin DataGateway's plugin loaded isn't on the row: the
 * registry's `refusalFor` asks that, between the two halves of this rule.
 */
function routingRefusal(row: RoutingRow | null, capability?: DataGatewayCapability): GatewayRefusalReason | null {
  if (!row) {
    return 'unknown';
  }

  if (!row.enabled) {
    return 'disabled';
  }

  // A plugin DataGateway is its plugin's to serve, whatever its own row says (#1083).
  if (row.pluginId !== null && !(row.plugin && isServed(row.plugin))) {
    return 'plugin_not_served';
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
 * Transport lives behind the driver port. A remote DataGateway's driver
 * comes lazily from `RemoteGatewayDriverFactory` (ping-verified gRPC). A
 * plugin DataGateway's comes lazily from the process's
 * {@link PluginDriverSource}, which the registry asks again whenever it
 * needs a new one, so it can rebuild a plugin's driver as it can dial a
 * remote DataGateway again (#1083). {@link register} stays for a driver
 * handed in whole, which the registry can't rebuild. Everything below the
 * port is transport-agnostic: the interview, failure tracking and
 * auto-disable treat every driver alike, whichever way it arrived.
 *
 * A DataGateway is routed only by its answers to the interview (#712). Its
 * first interview runs before its driver is cached, whichever way the driver
 * arrived, and a DataGateway whose first interview fails is neither cached
 * nor routed. Every routing decision then reads the DataGateway's row, so
 * both processes route by the answers whichever of them interviewed, and by
 * an admin's latest word on `enabled` and on the capabilities switched off
 * ({@link resolve}, {@link routableGatewayIds}).
 *
 * A plugin DataGateway's row is read with its plugin, and is routed only
 * while the server serves the plugin (it's a data-gateway plugin, switched
 * on, installed and not quarantined) and this process can reach a running
 * copy of that install. A process with no plugin driver source refuses every
 * plugin DataGateway. No config event tells of a plugin's state, so the
 * routing decision that finds a plugin's row disabled, as an uninstall
 * leaves it, or its plugin no longer loaded, also disposes the driver held
 * for it (#1083). It disposes only what was built for the install its row
 * names, or for an earlier one. A plugin can be installed again, and the
 * new install's driver built, while a decision waits: that decision's row
 * is stale by then, and it leaves the newer install's driver, cached or
 * still being built, alone.
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
  // ping, as connectPlugin() does before a plugin DataGateway's build, and
  // refuses to cache the freshly-built driver if it changed meanwhile
  // — closing the race where a 'disabled'/'deleted' event arrives mid-connect,
  // finds nothing cached to tear down, and connect() then caches a driver for a
  // gateway that is no longer valid (served indefinitely until the next event).
  // A routing decision that drops a plugin DataGateway's driver advances it
  // too, for the same race with a build under way. A stale decision doesn't:
  // one made on the row of an earlier install than this process holds a
  // driver for, cached or being built, leaves the counter and that driver as
  // they are (#1083).
  private readonly connectGeneration = new Map<string, number>();

  // For each plugin DataGateway whose driver is being built, the install of
  // its plugin that the build was begun for: the plugin's `installedAt`,
  // which a reinstall rewrites. connectPlugin() records it where it captures
  // the counter above, and clears it when the build settles, whichever way.
  // ensureConnected() shares one connect per DataGateway, so there is at most
  // one. Nothing is cached mid-build, so this is what tells a routing
  // decision that a build is of a newer install than its row names (#1083).
  private readonly installBeingBuilt = new Map<string, Date>();
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
    @Optional() @Inject(PLUGIN_DRIVER_SOURCE) private readonly pluginDrivers?: PluginDriverSource,
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
    this.installBeingBuilt.clear();
    this.connectionChanged.clear();
  }

  /**
   * Establishes (or re-establishes) a connection to the specified remote
   * DataGateway. The factory verifies via ping before a driver exists, and the
   * driver is cached only once the DataGateway has passed its first
   * interview ({@link register}). Existing drivers are disposed and replaced.
   * Failures to connect contribute to the failure-tracking counter that can
   * trigger auto-disable; a failed interview doesn't.
   *
   * The options come from a caller who may not have read the row, so this
   * reads whose row it is first, and refuses a plugin DataGateway's as
   * unknown, with a {@link GatewayRoutingRefusedError} (#1083): the mirror of
   * {@link pluginDriver} refusing a remote row. To whoever asks to dial it,
   * no remote DataGateway by that id is there. The refusal comes before
   * anything else, so the plugin's driver stays cached, nothing is dialled,
   * and no connection failure is counted. An id with no row is not refused
   * here: the options are dialled as given.
   */
  async connect(options: GatewayConnectionOptions): Promise<void> {
    // Snapshot the invalidation counter before the first wait, the read of
    // the row. If a 'disabled'/'deleted' event bumps it while we await that
    // or the ping, we must discard the driver we're about to cache rather
    // than serve a now-invalid DataGateway.
    const generation = this.connectGeneration.get(options.gatewayId) ?? 0;

    const row = await this.db.dataGateway.findFirst({
      where: { id: options.gatewayId },
      select: { pluginId: true },
    });

    if (row && row.pluginId !== null) {
      throw new GatewayRoutingRefusedError(options.gatewayId, 'unknown');
    }

    await this.dial(options, generation);
  }

  /**
   * Dials a remote DataGateway and caches its driver once it has passed its
   * first interview: what {@link connect} does once the row is known to be a
   * remote DataGateway's. The lazy connect calls it with the row it has
   * read, so that one isn't read again to learn the same (#1083).
   * `generation` is the invalidation counter as the caller snapshotted it.
   */
  private async dial(options: GatewayConnectionOptions, generation: number): Promise<void> {
    if (this.clients.has(options.gatewayId)) {
      this.logger.log(`Replacing existing connection for gateway ${options.gatewayId}`);
      this.disconnect(options.gatewayId);
    }

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
   * Places a driver handed in whole into the routing table under the given
   * gateway id and resets its failure history. connect() caches a remote
   * driver the same way after its ping, as a plugin DataGateway's is cached
   * after its build, and from then on the interview, routing, failure
   * tracking, and auto-disable are identical for all of them.
   *
   * A DataGateway never interviewed is interviewed first, and its driver is
   * cached only if that succeeds. Otherwise the driver is disposed and this
   * throws, so nothing is routed. A remote DataGateway is connected, or a
   * plugin DataGateway's driver built (#1083), and interviewed again when
   * next reached, but the gateway registry can't rebuild a driver handed in
   * here: whoever handed it in registers it again.
   */
  async register(
    gatewayId: string,
    driver: DataGatewayDriver,
    configHash = '',
    // Not 'plugin': only connectPlugin() records the install a plugin's
    // driver was built from, and a 'plugin' entry without it is dropped at the
    // next routing decision (#1083).
    origin: Exclude<DriverOrigin, 'plugin'> = 'registered',
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

    // A freshly-cached driver starts with a clean failure slate.
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
   * interviewed, a routing decision dropped what this process holds for a
   * plugin DataGateway meanwhile (#1083), or shutdown already disposed the
   * cached drivers. Returns true rather than throwing, so the invalidation
   * isn't counted as a connection failure; the caller (resolve) then finds no
   * cached driver and treats the DataGateway as unavailable, which is correct.
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
   * `void | Promise<void>` on the port, so async teardown — e.g. a plugin
   * DataGateway's driver closing handles — is awaited internally and its failure
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
   * or disabled, a plugin DataGateway whose plugin the server doesn't serve
   * or this process can't reach (#1083), one whose first interview hasn't
   * succeeded, and a capability it doesn't declare or that an admin switched
   * off. A refusal holds even while this process caches the driver, and
   * never counts toward auto-disable.
   *
   * On a cache miss the remote connection is established lazily from the
   * DB config (the source of truth), or a plugin DataGateway's driver built
   * by the plugin driver source, and concurrent callers for the same
   * DataGateway share a single in-flight connect, so a burst of jobs for a
   * newly added DataGateway triggers one connect — not a ping stampede.
   * Reaching a DataGateway never interviewed connects it, which interviews
   * it, before the capability is checked. One refused for any other reason
   * isn't connected first.
   *
   * Also throws when the connection (a remote DataGateway's ping, a plugin
   * DataGateway's build) or the first interview fails. Connection failures
   * feed the same auto-disable tracking as any other failed interaction.
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
   * search filters its search narrows by, or null when its coverage doesn't
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
   * A plugin DataGateway's driver, for the process that hosts the plugin
   * and answers for it over the gateway protocol (#1083). Refuses as
   * {@link resolve} does, and refuses a remote DataGateway as unknown: to
   * whoever asks for a plugin's driver, it isn't there.
   *
   * Without a capability, for a call that names none, such as a ping, it
   * refuses only a DataGateway that may not be used at all. It still
   * answers with the driver, so it builds one this process doesn't hold,
   * which interviews a DataGateway never interviewed.
   */
  async pluginDriver(gatewayId: string, capability?: DataGatewayCapability): Promise<DataGatewayDriver> {
    await this.routedRow(gatewayId, capability, true);

    return this.driverFor(gatewayId);
  }

  /**
   * How a search narrowed by `filter` reaches the DataGateway now, by one
   * read of its row, without connecting it: for a caller that may answer
   * without the driver, such as a search served from its cache, or one the
   * DataGateway's coverage can't match. One that must ask it after all takes
   * the route's driver. It connects nothing, though it drops the driver held
   * for a plugin DataGateway whose row is disabled or whose plugin is no
   * longer loaded (#1083).
   */
  async searchRoute(gatewayId: string, filter: CoverageFilter): Promise<SearchRoute> {
    const row = await this.routingRow(gatewayId);

    if (!row || (await this.refusalFor(gatewayId, row, DataGatewayCapability.Search))) {
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
   * capability now: enabled, past their first interview, declaring it,
   * without an admin's switch-off, and, for a plugin DataGateway, with its
   * plugin served and loaded (#1083). A search that names no DataGateway goes
   * to these; one this process hasn't connected yet isn't reached that way
   * (#722). A search narrowed by `filter` goes only to those whose coverage
   * overlaps it. A plugin DataGateway left out because its row is disabled
   * or its plugin is no longer loaded has its driver dropped as well (#1083).
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

    // The rows come from one read. Whether its plugin is loaded is then
    // asked for each plugin DataGateway among them (#1083).
    const refusals = await Promise.all(rows.map((row) => this.refusalFor(row.id, row, capability)));

    const routable = new Set(
      rows.filter((row, index) => refusals[index] === null && coverageOverlaps(row, filter)).map((row) => row.id),
    );
    return connected.filter((gatewayId) => routable.has(gatewayId));
  }

  /**
   * Interviews a DataGateway now, however recent its answers: for an admin
   * who asks (#715 adds the route). Connects it first if this process hasn't,
   * and for a DataGateway never interviewed, that connect is the interview.
   * Throws when it's absent, deleted or disabled, when its plugin isn't
   * served or loaded (#1083), or when the interview fails, which the row
   * records.
   */
  async reinterview(gatewayId: string): Promise<void> {
    const row = await this.routingRow(gatewayId);
    const refusal = await this.refusalFor(gatewayId, row);
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
   * have gone stale: the hourly backstop's job.
   *
   * It makes the routing decision first, and asks nothing of a DataGateway
   * the decision refuses. Holding a driver isn't leave to use it: no config
   * event tells of a plugin's state, so this process can still hold the
   * driver of a plugin that was disabled, uninstalled or quarantined since,
   * and a plugin behind its server switch must not be called. The decision
   * also disposes the driver of a plugin that was uninstalled or is no
   * longer loaded, so that one is held for at most an hour after its last
   * use (#1083).
   *
   * Never throws. When the decision can't be made, because the row can't be
   * read, the check is skipped and logged.
   */
  async refreshInterview(gatewayId: string): Promise<void> {
    if (!this.clients.has(gatewayId)) {
      return;
    }

    try {
      if (await this.refusalFor(gatewayId, await this.routingRow(gatewayId))) {
        return;
      }
    } catch (err) {
      this.logger.warn(
        `Skipping the check of DataGateway ${gatewayId}'s interview: couldn't decide whether it may be used: ${
          err instanceof Error ? err.message : err
        }`,
      );
      return;
    }

    // The decision waited, and may itself have dropped the driver.
    const cached = this.clients.get(gatewayId);
    if (cached) {
      await this.interviews.refreshIfStale(gatewayId, cached.driver);
    }
  }

  /**
   * The row of a DataGateway that may serve the capability now, connecting
   * and so interviewing it first when it never was. Without a capability,
   * the row of one that may be used at all, which connects nothing. Throws a
   * {@link GatewayRoutingRefusedError} when it may not. With `pluginOnly`, a
   * remote DataGateway is refused as unknown.
   */
  private async routedRow(
    gatewayId: string,
    capability?: DataGatewayCapability,
    pluginOnly = false,
  ): Promise<RoutingRow> {
    let row = await this.routingRow(gatewayId, pluginOnly);
    let refusal = await this.refusalFor(gatewayId, row, capability);

    // A connect can lift this refusal alone, since connecting interviews.
    // Every refusal that comes before it stands whatever a connect would
    // find, so a DataGateway that may not be used is never connected, nor
    // its plugin's driver built, to learn that (#1083).
    if (refusal === 'not_interviewed') {
      await this.ensureConnected(gatewayId);
      row = await this.routingRow(gatewayId, pluginOnly);
      refusal = await this.refusalFor(gatewayId, row, capability);
    }

    if (refusal) {
      throw new GatewayRoutingRefusedError(gatewayId, refusal, capability);
    }

    // routingRefusal refuses an absent row, so there is one.
    return row as RoutingRow;
  }

  /**
   * The routing decision every caller makes: {@link routingRefusal}, with
   * the one reason a row can't give, that this process can't reach a plugin
   * DataGateway's plugin (#1083). In order: whether the DataGateway may be
   * used at all, by its row and its plugin's; whether the plugin is loaded;
   * then, with a capability, the interview's and the capability's reasons.
   * So a plugin the server doesn't serve is never asked after, and the
   * plugin's reasons hold with or without a capability.
   *
   * It is more than a question. When it finds a plugin DataGateway's row
   * disabled, its plugin not loaded, or its driver built from an earlier
   * install of the plugin, it also drops what this process holds for it
   * ({@link dropPluginDriver}). Nothing else would. Uninstalling a plugin
   * disables its row, as does an update that moves it out of the
   * data-gateway category, and neither publishes a config event. A driver
   * that isn't disposed keeps the plugin's handles and timers until the
   * process restarts. One whose plugin isn't loaded reaches a copy that is
   * gone, and one built from an earlier install reaches that install's copy.
   * The next use builds a driver from the copy loaded then.
   *
   * A decision can be overtaken. Its row was read before it ran, and it may
   * wait on the source, and in that time the plugin can be installed again
   * and the new install's driver built, or its build begun. What the
   * decision found is true of the install its row names, so it drops only
   * what is held for that install or an earlier one. When this process
   * holds a newer install's driver, cached or being built, the decision is
   * stale: it still answers its caller with its own refusal, and touches
   * nothing.
   *
   * No other answer touches the cache. A plugin that is only switched off
   * keeps its driver, unused, for when it is switched on again: disposing it
   * would fail the calls still under way, and those failures would count
   * toward disabling a DataGateway that did nothing wrong. A remote
   * DataGateway's driver is the config events' to take down.
   */
  private async refusalFor(
    gatewayId: string,
    row: RoutingRow | null,
    capability?: DataGatewayCapability,
  ): Promise<GatewayRefusalReason | null> {
    const unusable = routingRefusal(row);
    if (unusable || !row) {
      if (unusable === 'disabled' && row && row.pluginId !== null) {
        this.dropPluginDriver(gatewayId, row.plugin);
      }

      return unusable;
    }

    if (row.plugin) {
      const loaded = await this.isLoaded(row.plugin);

      if (loaded !== true) {
        // A source that couldn't say leaves the driver: nothing says its copy is gone.
        if (loaded === false) {
          this.dropPluginDriver(gatewayId, row.plugin);
        }

        return 'plugin_not_loaded';
      }

      // `isLoaded` answers for the install the row names now. A reinstall
      // between two uses that no decision saw, the row disabled and enabled
      // again, leaves the earlier install's driver cached, so it is dropped
      // here and the next use builds one from this install.
      if (this.heldForEarlierInstall(gatewayId, row.plugin)) {
        this.dropPluginDriver(gatewayId, row.plugin);
      }
    }

    return capability === undefined ? null : routingRefusal(row, capability);
  }

  /**
   * Whether this process can reach a running copy of this install of the
   * plugin: false with no plugin driver source, and null when the source
   * failed to say. One plugin's failed lookup must not fail a listing of
   * every DataGateway, so it is logged here and read by the caller as not
   * loaded, for that decision alone.
   */
  private async isLoaded(plugin: RoutedPlugin): Promise<boolean | null> {
    if (!this.pluginDrivers) {
      return false;
    }

    try {
      return await this.pluginDrivers.isLoaded(plugin);
    } catch (err) {
      this.logger.warn(
        `Couldn't tell whether plugin '${plugin.slug}' is loaded, so its DataGateway is refused for now: ${
          err instanceof Error ? err.message : err
        }`,
      );

      return null;
    }
  }

  /**
   * Whether the driver cached for a plugin DataGateway was built from an
   * earlier install of its plugin than `plugin`'s. Switching the plugin off
   * and on keeps its install, and so its driver. One built from a later
   * install stays as well: the row that names `plugin` is then the stale
   * one (#1083).
   */
  private heldForEarlierInstall(gatewayId: string, plugin: RoutedPlugin): boolean {
    const cached = this.clients.get(gatewayId);

    if (cached?.origin !== 'plugin') {
      return false;
    }

    // One cached without its install can't be matched to any, so it counts as earlier.
    return cached.installedAt === undefined || cached.installedAt.getTime() < plugin.installedAt.getTime();
  }

  /**
   * Drops what this process holds for a plugin DataGateway whose row is
   * disabled, whose plugin isn't loaded, or whose driver was built from an
   * earlier install of its plugin: the cached driver, which is
   * disposed, and a driver still being built or interviewed, which is
   * discarded when done instead of cached. That one was built from a copy of
   * the plugin this decision found gone, and cached, it would be served once
   * the plugin reads as loaded again.
   *
   * `plugin` is the plugin as the decision's row read it, and every drop a
   * decision makes comes through here, so this is where a stale decision
   * stops. When this process holds a driver of a newer install than
   * `plugin`'s ({@link holdsNewerInstall}), nothing is dropped: the
   * invalidation counter stays, so no build is discarded, no driver is
   * disposed, and no interview is abandoned (#1083). A row read without its
   * plugin names no install to compare, and drops.
   */
  private dropPluginDriver(gatewayId: string, plugin: RoutedPlugin | null): void {
    if (plugin && this.holdsNewerInstall(gatewayId, plugin)) {
      return;
    }

    this.bumpConnectGeneration(gatewayId);

    if (this.clients.has(gatewayId)) {
      this.disconnect(gatewayId);
    }
  }

  /**
   * Whether this process holds, for a plugin DataGateway, the driver of a
   * later install of its plugin than `plugin`'s: one cached, or one whose
   * build is under way.
   *
   * It takes `installedAt` to put installs in order, which is an assumption:
   * the value is the clock of the process that installed. A reinstall
   * stamped earlier than the install before it, by a clock set back or two
   * processes' clocks apart, would make current decisions read as stale, and
   * the earlier install's driver would stay held until a restart or a
   * 'disabled' event.
   */
  private holdsNewerInstall(gatewayId: string, plugin: RoutedPlugin): boolean {
    const newer = (held: Date | undefined): boolean =>
      held !== undefined && held.getTime() > plugin.installedAt.getTime();

    return newer(this.clients.get(gatewayId)?.installedAt) || newer(this.installBeingBuilt.get(gatewayId));
  }

  /**
   * The DataGateway's routing row, null when it's absent or deleted. With
   * `pluginOnly`, a remote DataGateway's row reads as absent too.
   */
  private routingRow(gatewayId: string, pluginOnly = false): Promise<RoutingRow | null> {
    return this.db.dataGateway.findFirst({
      where: { id: gatewayId, deletedAt: null, ...(pluginOnly && { pluginId: { not: null } }) },
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
   * connection: a remote DataGateway is dialled, and a plugin DataGateway's
   * driver is built ({@link connectPlugin}). Throws if the gateway no longer
   * qualifies for connection — callers should treat that as "gateway
   * unavailable".
   */
  private async connectFromDb(gatewayId: string): Promise<void> {
    const gateway = await this.db.dataGateway.findFirst({
      where: { id: gatewayId, enabled: true, deletedAt: null },
      include: { plugin: { select: ROUTED_PLUGIN_FIELDS } },
    });

    if (!gateway) {
      throw new Error(`Gateway ${gatewayId} is not available (absent, disabled, or deleted); cannot connect.`);
    }

    // A plugin DataGateway has nothing to dial: its driver comes from the plugin driver source (#1083).
    if (gateway.pluginId !== null) {
      await this.connectPlugin(gateway);
      return;
    }

    // A remote DataGateway's row always has its connection fields, so this
    // only narrows the nullable columns.
    const options = remoteConnectionOptions(gateway);
    if (!options) {
      throw new Error(`DataGateway ${gatewayId} has no connection fields; cannot connect.`);
    }

    this.logger.log(`Lazily connecting to gateway '${gateway.name}' (${gatewayId}) on demand`);

    // The row read above is a remote DataGateway's, so this dials without
    // connect()'s own read of it.
    await this.dial(options, this.connectGeneration.get(gatewayId) ?? 0);
  }

  /**
   * Builds a plugin DataGateway's driver from the plugin driver source, and
   * caches it once the DataGateway has passed its first interview: what
   * {@link connect} is to a remote DataGateway (#1083). `gateway` is the
   * DataGateway's row, with its plugin as read beside it.
   */
  private async connectPlugin(gateway: RoutingRow & { id: string; name: string }): Promise<void> {
    const { id: gatewayId, plugin } = gateway;

    // Snapshot the invalidation counter before the first wait, as connect()
    // does: a 'disabled' or 'deleted' event that arrives while the driver is
    // being built finds nothing cached to tear down.
    //
    // It is taken here, after connectFromDb() has read the row, and must
    // stay after that read. While the row is read nothing is on record for
    // this build, so a routing decision made on an earlier install's row
    // drops as usual and advances the counter. A snapshot from before the
    // read would then be out of date, and this build, of the newer install,
    // discarded for it (#1083).
    const generation = this.connectGeneration.get(gatewayId) ?? 0;

    // The install this build is for goes on record at the same moment, and
    // stays there until the build settles. Nothing is cached meanwhile to
    // name it, and a routing decision made on an earlier install's row must
    // leave this build alone (see dropPluginDriver). Such a decision can
    // land as early as this build's own decision, next, which waits too.
    if (plugin) {
      this.installBeingBuilt.set(gatewayId, plugin.installedAt);
    }

    try {
      // Not every connect follows a routing decision: a 'reconnect-requested'
      // event doesn't, and a search takes its route's driver after the route
      // was read. So the same decision is made here, on the row just read, and
      // no path builds a driver for a plugin the server doesn't serve or this
      // process can't reach. A refusal counts as no failure, here as anywhere.
      const refusal = await this.refusalFor(gatewayId, gateway);
      const source = this.pluginDrivers;

      // The decision passes a plugin's row only with its plugin read and a
      // source that has it loaded, so the last two only narrow the types.
      if (refusal || !plugin || !source) {
        throw new GatewayRoutingRefusedError(gatewayId, refusal ?? 'plugin_not_loaded');
      }

      this.logger.log(`Lazily building the driver of plugin DataGateway '${gateway.name}' (${gatewayId}) on demand`);

      let driver: DataGatewayDriver;
      try {
        driver = await source.build(gatewayId, plugin);
      } catch (err) {
        // A build that fails is a DataGateway that can't be reached, as a
        // remote one's failed ping is. A source that refuses instead found the
        // plugin's copy gone since it was asked, which is nothing the
        // DataGateway did.
        if (!(err instanceof GatewayRoutingRefusedError)) {
          await this.reportFailure(gatewayId, err, 'repeated_connection_failure');
        }

        throw err;
      }

      // No config hash: no connection fields went into the driver, so no
      // 'updated' event can outdate it. A reinstall can, so the install it was
      // built from is kept with it.
      await this.interviewAndCache(
        { gatewayId, driver, configHash: '', origin: 'plugin', installedAt: plugin.installedAt },
        generation,
      );
    } finally {
      this.installBeingBuilt.delete(gatewayId);
    }
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
   * calls — the tracking is transport-agnostic, so a plugin DataGateway's
   * driver throwing repeatedly auto-disables exactly like a dead remote.
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

    // An 'updated' event tells of a change to a remote DataGateway's
    // connection fields. A driver handed to register() and a plugin
    // DataGateway's were built from none, so each stays as it is.
    // 'reconnect-requested' is ignored only for a driver handed to
    // register(): the registry can't rebuild it, and dropping it would send
    // the next resolve() to connectFromDb, which would dial the row as a
    // remote DataGateway, with no way back. A plugin DataGateway's driver it
    // can rebuild from the plugin driver source, so that one is dropped and
    // built again below (#1083). Admin intent still wins: 'disabled' and
    // 'deleted' fall through and tear down any origin.
    const keepsItsDriver =
      cached !== undefined &&
      ((event.changeType === 'updated' && cached.origin !== 'remote') ||
        (event.changeType === 'reconnect-requested' && cached.origin === 'registered'));

    if (keepsItsDriver) {
      this.logger.debug(
        `Ignoring '${event.changeType}' config event for DataGateway ${event.gatewayId}, whose driver's origin is '${cached.origin}'`,
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
