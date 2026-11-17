import { AuditContextService, SystemActorScope } from '@bge/actor-context';
import { createOutboundActorMetadataInterceptor } from '@bge/actor-context-transport';
import { AuthType, DatabaseService, hasLivePluginLoad } from '@bge/database';
import type { PluginDriverSource, RoutedPlugin } from '@bge/gateway-registry';
import { RemoteGatewayDriverFactory } from '@bge/gateway-registry';
import { BGE_GATEWAY_ID_HEADER } from '@bge/shared';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import { aroundDriverCalls } from '@boardgamesempire/gateway-driver-contract';
import type { Interceptor, InterceptorOptions, NextCall } from '@grpc/grpc-js';
import { InterceptingCall } from '@grpc/grpc-js';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isIPv6 } from 'node:net';
import type { Observable } from 'rxjs';
import { defer } from 'rxjs';

/** The reason the system actor states on a call that goes to the coordinator with no actor behind it. */
const RELAY_REASON = 'plugin-gateway-relay';

/**
 * A grpc-js client `Interceptor` that names, in the metadata of every call,
 * the plugin DataGateway the call is for. The coordinator serves the gateway
 * gRPC protocol for all of its plugins at one address, and reads from this
 * which plugin's driver answers (#1083).
 *
 * The actor's interceptor, on the same client, catches a failure to write its
 * metadata and lets the call go out. This one doesn't: the coordinator would
 * refuse a call that names no DataGateway.
 */
function createGatewayIdMetadataInterceptor(gatewayId: string): Interceptor {
  return (options: InterceptorOptions, nextCall: NextCall) =>
    new InterceptingCall(nextCall(options), {
      start: (metadata, listener, next) => {
        metadata.set(BGE_GATEWAY_ID_HEADER, gatewayId);
        next(metadata, listener);
      },
    });
}

/**
 * The gateway worker's plugin driver source (#1083). The gateway worker loads
 * no plugin. The coordinator runs the one copy of each data-gateway plugin
 * and serves the gateway gRPC protocol for it, so this source answers whether
 * a plugin is loaded from the coordinator's plugin load records, and builds a
 * driver that is a gRPC client of the coordinator.
 */
@Injectable()
export class PluginGatewayRelaySource implements PluginDriverSource {
  constructor(
    private readonly db: DatabaseService,
    private readonly drivers: RemoteGatewayDriverFactory,
    private readonly config: ConfigService,
    private readonly audit: AuditContextService,
    private readonly systemActorScope: SystemActorScope,
  ) {}

  /**
   * Whether a running coordinator has loaded this install of the plugin, as
   * its plugin load records say.
   *
   * Nothing is kept between asks. A coordinator that shuts down cleanly
   * deletes its records so that the gateway registry refuses the DataGateway
   * from then on, and an answer kept from before would have it dial an
   * address nothing answers at, and count each failure against the
   * DataGateway.
   *
   * A lookup that fails rejects, uncaught: the gateway registry reads that as
   * not loaded for the one decision that asked, and keeps the driver it holds.
   */
  isLoaded(plugin: RoutedPlugin): Promise<boolean> {
    return hasLivePluginLoad(this.db, plugin, 'coordinator');
  }

  /**
   * A driver whose every call goes to the coordinator, with the DataGateway's
   * id and the actor in scope in its metadata. The factory pings before it
   * hands the driver out, and when nothing answers, its error rejects here,
   * uncaught: the gateway registry counts it as a failed connect, as it does
   * for a remote DataGateway that is down.
   *
   * The coordinator refuses a call that carries no actor. Most calls the
   * gateway worker routes are made inside the actor scope of the job that
   * caused them, and go out as that actor. One made with no actor in scope,
   * as the interview's hourly backstop makes from its timer, goes out as the
   * system actor. So does the ping, when the build was asked for with no
   * actor in scope.
   */
  async build(gatewayId: string): Promise<DataGatewayDriver> {
    const address = this.config.getOrThrow<string>('coordinatorClient.host');

    const dial = () =>
      this.drivers.create(
        {
          gatewayId,
          // The factory joins the address to the port as written, and gRPC
          // finds no port in an IPv6 address that isn't bracketed.
          connectionUrl: isIPv6(address) ? `[${address}]` : address,
          connectionPort: this.config.getOrThrow<number>('coordinatorClient.port'),
          authType: AuthType.None,
        },
        { interceptors: [createOutboundActorMetadataInterceptor(), createGatewayIdMetadataInterceptor(gatewayId)] },
      );

    // `run` keeps the scope through the factory's waits between tries of the
    // ping.
    const driver = await (this.hasActor() ? dial() : this.systemActorScope.run(RELAY_REASON, dial));

    // Each call decides when it is subscribed, not here and not when its
    // operation is called: gRPC sends a call when it is subscribed, and the
    // actor's interceptor reads the scope then.
    //
    // A call made with no actor is subscribed inside the system actor's
    // scope, so its answer is delivered there too: an operator piped onto the
    // driver's Observable sees the system actor, with this relay's reason,
    // until the code that awaits the answer resumes in its own context. A
    // call made with an actor is untouched. So whoever uses a driver reads the
    // actor after its `await`, or before the call, never inside an operator
    // downstream of the answer.
    return aroundDriverCalls(driver, <T>(call: () => Observable<T>): Observable<T> =>
      defer(() => (this.hasActor() ? call() : this.systemActorScope.runObservable(RELAY_REASON, call))),
    );
  }

  private hasActor(): boolean {
    return this.audit.getActor() !== null;
  }
}
