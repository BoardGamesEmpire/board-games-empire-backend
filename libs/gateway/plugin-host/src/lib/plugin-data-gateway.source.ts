import { PluginActorScope, SERVER_PLUGIN_UNIT } from '@bge/actor-context';
import type { PluginDriverSource, RoutedPlugin } from '@bge/gateway-registry';
import { GatewayRoutingRefusedError } from '@bge/gateway-registry';
import type { LoadedPlugin } from '@bge/plugin';
import { PluginInstanceRegistry } from '@bge/plugin';
import type { DataGatewayDriver, DataGatewayDriverFactory } from '@boardgamesempire/gateway-driver-contract';
import {
  aroundDriverCalls,
  isDataGatewayDriver,
  isDataGatewayDriverFactory,
} from '@boardgamesempire/gateway-driver-contract';
import { Injectable, Logger } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { from, Observable, Subject, takeUntil } from 'rxjs';
import { PluginDataGatewayBuildError, PluginDataGatewayBuildTimeoutError } from './plugin-host.errors';

/**
 * How long a plugin's driver factory may take to hand over a driver before
 * the build fails (#1083). The gateway registry puts no time limit on a
 * build, and every caller of a DataGateway shares its one connect, so a
 * driver factory that never settled would hold them all, with nothing
 * counted toward auto-disable and nothing logged, until a restart.
 *
 * A constant, not a setting. A driver may need starting before its first
 * call, such as fetching a token from its upstream, and half a minute is
 * generous for that. A server admin has nothing to tune here: a driver that
 * needs longer is one its plugin author should start in the background.
 */
export const PLUGIN_DRIVER_BUILD_TIMEOUT_MS = 30_000;

/**
 * Runs `work` as the plugin actor. `reason` names what the server was doing,
 * for the plugin's trigger when no actor is in scope.
 */
type RunAsPlugin = <T>(reason: string, work: () => T) => T;

/**
 * One call of a plugin driver's operation, as the server's Observable. The
 * edge of the plugin's actor scope runs through it, and neither side's actor
 * crosses (#1083).
 *
 * The plugin's side runs as the plugin: the operation is called, and its
 * answer subscribed to, once the server subscribes, both inside the plugin's
 * actor scope, so the plugin's work from there on stays in it. So does the
 * answer's teardown when the server stops listening, which is the plugin's
 * code again: it runs as the plugin, with whoever stopped listening as its
 * trigger, and not with that actor's authority.
 *
 * The server's side runs as whoever subscribed: `next`, `error` and
 * `complete` reach the server's subscriber in the async context it
 * subscribed in, captured then and entered again for each. Delivered from
 * where the plugin emits them, they would run the server's own RxJS
 * operators, and the reads and writes those make, as the plugin.
 *
 * The plugin is another package and may answer with its own copy of RxJS's
 * Observable, with a Promise or with any other thenable, so its answer goes
 * through the server's `from()`, inside the plugin's actor scope. The
 * server's RxJS operators then only ever meet the server's Observable, and a
 * thenable's `then`, which is the plugin's code, is called as the plugin. A
 * throw from the operation, or an answer `from()` can't read, surfaces as
 * that Observable's error.
 */
function callAsPlugin<T>(asPlugin: RunAsPlugin, call: () => Observable<T>): Observable<T> {
  const reason = 'plugin-data-gateway-call';

  return new Observable<T>((subscriber) => {
    // Every store at once: the actor's, and tracing's.
    const asSubscriber = AsyncLocalStorage.snapshot();

    // A plugin may emit from inside the subscribe call below, before there
    // is an `answer` to unsubscribe. An RxJS operator of the server's that
    // stops listening in such a `next` (`take(1)`) closes the server's
    // subscriber and can reach nothing of the plugin's, so this stops the
    // answer from where the plugin emitted, which is inside the plugin's
    // actor scope.
    const serverStoppedListening = new Subject<void>();

    const answer = asPlugin(reason, () =>
      from(call())
        .pipe(takeUntil(serverStoppedListening))
        .subscribe({
          next: (value) => {
            asSubscriber(() => subscriber.next(value));

            if (subscriber.closed) {
              serverStoppedListening.next();
            }
          },
          error: (err: unknown) => asSubscriber(() => subscriber.error(err)),
          complete: () => asSubscriber(() => subscriber.complete()),
        }),
    );

    // Called from whatever scope the server unsubscribes in.
    return () => asPlugin(reason, () => answer.unsubscribe());
  });
}

/**
 * The plugin driver source of the process that loads data-gateway plugins,
 * the coordinator (#1083). It answers the gateway registry from this
 * process's own `PluginInstanceRegistry`: a plugin is loaded when a copy of
 * the install its row names is held there, and a driver is built by calling
 * what that copy's factory returned, its driver factory.
 *
 * A driver it builds keeps the plugin's code and the server's each under
 * its own actor.
 *
 * Everything of the plugin's, it runs as the plugin actor: the driver
 * factory, each operation with its answer's subscription and teardown,
 * `dispose` and `handleInbound`. A plugin acts with the authority consented
 * to it and never with that of whoever set it running, and the gateway
 * registry reaches a driver from whatever work is under way: a user's
 * search, a config event, the interview backstop's timer, shutdown. The
 * actor in scope then is recorded as the plugin's trigger, and lends it
 * nothing. A DataGateway serves the whole server, so the plugin acts as its
 * Server-scope self.
 *
 * What the plugin returns is resolved inside its actor scope as well, and
 * only the settled value leaves it. A thenable that is no native Promise,
 * such as a client library's request object, starts its work when its
 * `then` is called. Handed back as it is, that would be whoever awaits it
 * calling the plugin's code in their own scope.
 *
 * The one limit is the reading of a property of what the plugin returned,
 * as the check that it is a driver and a promise's lookup of `then` do: it
 * happens in the scope of whoever asked, which runs none of the plugin's
 * code for an ordinary object, and would run a getter or a Proxy's trap.
 *
 * Nothing of the server's runs as the plugin. An operation's answer is
 * delivered to the server's subscriber in the context it subscribed in
 * ({@link callAsPlugin}), so the server's RxJS operators after it run as
 * whoever subscribed. What the server awaits, a build, `dispose` or
 * `handleInbound`, it resumes from in its own context as any await does.
 *
 * A build always settles: the driver factory has
 * {@link PLUGIN_DRIVER_BUILD_TIMEOUT_MS} to hand over a driver.
 */
@Injectable()
export class PluginDataGatewaySource implements PluginDriverSource {
  private readonly logger = new Logger(PluginDataGatewaySource.name);

  constructor(
    private readonly plugins: PluginInstanceRegistry,
    private readonly pluginActorScope: PluginActorScope,
  ) {}

  /**
   * Whether this process holds a running copy of this install of the plugin:
   * its `PluginInstanceRegistry` has the slug, loaded from the same plugin
   * row at the same `installedAt`. It reads memory alone, so it never
   * rejects.
   *
   * `installedAt` names the install and not the version: a reinstall
   * rewrites it, and a plugin update keeps it. Matching on it alone is
   * enough because an update never swaps a plugin's module inside a running
   * process. Activation marks the plugin restart required, and the copy in
   * memory serves until the process restarts. So one install has one copy
   * here for as long as the process runs, and the gateway registry rightly
   * keeps the driver built from it across an update. If a new copy is ever
   * loaded into a running process, as propagating a plugin's state between
   * processes could do (#332), this must match the copy that is loaded, by
   * its plugin artifact's sha256, and not the install alone.
   */
  async isLoaded(plugin: RoutedPlugin): Promise<boolean> {
    return this.loadedCopy(plugin) !== undefined;
  }

  /**
   * A new driver from the plugin's driver factory, which is called again
   * for each build.
   *
   * It refuses, as not loaded, a plugin this process holds no copy of for
   * the install the row names: the gateway registry asked {@link isLoaded}
   * first, so the copy went in between, which is no failure of the
   * DataGateway's. It rejects with a {@link PluginDataGatewayBuildError}
   * when the plugin provides no driver: what it loaded with is no driver
   * factory, though the loader's product check normally refuses such a
   * plugin when it loads, or the driver factory returned something that
   * isn't a driver, which is disposed of first when it can be. It rejects
   * with a {@link PluginDataGatewayBuildTimeoutError} when the driver
   * factory takes longer than {@link PLUGIN_DRIVER_BUILD_TIMEOUT_MS}. The
   * registry counts each of those rejections, and the plugin's own error
   * when its driver factory fails, as a failed connect.
   */
  async build(gatewayId: string, plugin: RoutedPlugin): Promise<DataGatewayDriver> {
    const loaded = this.loadedCopy(plugin);

    if (!loaded) {
      throw new GatewayRoutingRefusedError(gatewayId, 'plugin_not_loaded');
    }

    const driverFactory = loaded.instance;

    if (!isDataGatewayDriverFactory(driverFactory)) {
      throw new PluginDataGatewayBuildError(plugin.slug);
    }

    const asPlugin: RunAsPlugin = (reason, work) =>
      this.pluginActorScope.run(plugin.id, SERVER_PLUGIN_UNIT, reason, work);

    const driver = await this.startDriver(plugin.slug, asPlugin, driverFactory);

    if (!isDataGatewayDriver(driver)) {
      this.discard(plugin.slug, asPlugin, driver);

      throw new PluginDataGatewayBuildError(plugin.slug);
    }

    const served: DataGatewayDriver = {
      // Each operation's call, its answer's subscription and its teardown
      // run as the plugin, and the answer reaches the server's subscriber as
      // whoever subscribed: both halves are `callAsPlugin`'s.
      ...aroundDriverCalls(driver, <T>(call: () => Observable<T>) => callAsPlugin(asPlugin, call)),

      // `aroundDriverCalls` passes `dispose` and `handleInbound` through as
      // they are, and the gateway registry disposes a driver from whatever
      // work drops it. Each is an async function so that what the plugin
      // returns is resolved inside its actor scope (see `startDriver`).
      dispose: () => asPlugin('plugin-data-gateway-dispose', async () => driver.dispose()),
    };

    const handleInbound = driver.handleInbound?.bind(driver);

    if (handleInbound) {
      served.handleInbound = (event) => asPlugin('plugin-data-gateway-inbound', async () => handleInbound(event));
    }

    return served;
  }

  /**
   * What the plugin's driver factory hands over, called as the plugin. It
   * rejects with a {@link PluginDataGatewayBuildTimeoutError} when the driver
   * factory hasn't settled within {@link PLUGIN_DRIVER_BUILD_TIMEOUT_MS}, so
   * a build always settles.
   *
   * The driver factory can't be stopped, only no longer waited for. A driver
   * it hands over after that is disposed of, and never returned: the gateway
   * registry was told the build failed, and holds nothing to dispose it by.
   * A failure after that is logged, since nothing else would hear of it.
   */
  private async startDriver(
    slug: string,
    asPlugin: RunAsPlugin,
    driverFactory: DataGatewayDriverFactory,
  ): Promise<unknown> {
    // An async function, so that what the driver factory returns is resolved
    // inside the plugin's actor scope. Returned as it is, a thenable would
    // have its `then` called, and the work that starts, in the scope of
    // whoever awaits it.
    const starting = asPlugin('plugin-data-gateway-build', async (): Promise<unknown> => driverFactory());

    const outOfTime = Symbol('out of time');
    let timer: NodeJS.Timeout | undefined;
    const waitedLongEnough = new Promise<typeof outOfTime>((resolve) => {
      timer = setTimeout(() => resolve(outOfTime), PLUGIN_DRIVER_BUILD_TIMEOUT_MS);

      // A wait for a plugin is no reason to keep the process from exiting.
      timer.unref();
    });

    try {
      const started = await Promise.race([starting, waitedLongEnough]);

      if (started !== outOfTime) {
        return started;
      }
    } finally {
      clearTimeout(timer);
    }

    void starting.then(
      (late) => this.discard(slug, asPlugin, late),
      (err: unknown) =>
        this.logger.warn(
          `Plugin '${slug}' failed to start its DataGateway driver, after the server had stopped waiting for it: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
    );

    throw new PluginDataGatewayBuildTimeoutError(slug, PLUGIN_DRIVER_BUILD_TIMEOUT_MS);
  }

  /**
   * Disposes, as the plugin and best effort, of something the plugin's
   * driver factory handed over that the server won't use: a product that
   * isn't a driver, or a driver that came too late. Whatever has a `dispose`
   * may hold handles and timers, and each failed build would leave one more
   * behind.
   *
   * It doesn't wait for the dispose, since a build must settle whatever the
   * plugin's `dispose` does. A dispose that fails is logged, and nothing is
   * thrown from here.
   */
  private discard(slug: string, asPlugin: RunAsPlugin, product: unknown): void {
    // `dispose` is read inside the async function as well, so that one that
    // can't even be read ends as the logged rejection too.
    void asPlugin('plugin-data-gateway-dispose', async () => {
      const disposable = (typeof product === 'object' && product !== null) || typeof product === 'function';
      const dispose: unknown = disposable ? Reflect.get(product, 'dispose') : undefined;

      if (typeof dispose === 'function') {
        await Reflect.apply(dispose, product, []);
      }
    }).catch((err: unknown) =>
      this.logger.warn(
        `Failed to dispose of what plugin '${slug}' handed over, which the server did not use: ${
          err instanceof Error ? err.message : String(err)
        }`,
      ),
    );
  }

  /** The copy of the plugin this process loaded, when it is a copy of the install the row names. */
  private loadedCopy(plugin: RoutedPlugin): LoadedPlugin | undefined {
    const loaded = this.plugins.get(plugin.slug);

    if (loaded?.pluginId !== plugin.id || loaded.installedAt.getTime() !== plugin.installedAt.getTime()) {
      return undefined;
    }

    return loaded;
  }
}
