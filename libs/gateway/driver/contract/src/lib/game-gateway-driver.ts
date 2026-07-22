import type { GatewayServiceClient } from '@boardgamesempire/proto-gateway';
import type { GatewayInboundEvent } from './types.js';

/**
 * The transport-agnostic port for game data gateways (#193, epic #192 D1/D2).
 *
 * Proto-first taken literally: the call surface IS the ts-proto
 * `GatewayServiceClient` interface generated from `bge.gateway.v1`, so the
 * in-process and remote adapters cannot drift from the wire contract — there
 * is exactly one type. Implementations:
 *
 *  - `RemoteGatewayDriver` (`@bge/gateway-registry`): proxies an external gRPC
 *    gateway service. Server-internal.
 *  - In-process `DataGateway` plugins (#59/#194): implement this interface
 *    directly. Third-party authors depend on this package.
 *  - `InMemoryGatewayDriver` (`@boardgamesempire/gateway-contract-testing`):
 *    fixture-backed test double; also the reference for expected semantics.
 *
 * Semantics that implementations MUST honor (enforced by the shared contract
 * suite in `@boardgamesempire/gateway-contract-testing`):
 *
 *  - Streaming RPCs (`searchGames`, `fetchExpansions`) emit zero or more
 *    RESULT frames and terminate the stream; search streams end with a
 *    SOURCE_DONE frame.
 *  - A clean "no such game" on `fetchGame` is a RESPONSE with `game` unset —
 *    never a thrown/errored Observable. Consumers rely on this to distinguish
 *    healthy not-found interactions from transport failures (auto-disable
 *    tracking exempts the former).
 *  - `dispose()` releases transport resources and must be safe to call on an
 *    already-disposed driver.
 */
export interface GameGatewayDriver extends GatewayServiceClient {
  /**
   * Releases any resources held by the driver (gRPC channels, timers, open
   * handles). In-process drivers with nothing to release implement a no-op.
   * Must not throw when called more than once.
   */
  dispose(): void | Promise<void>;

  /**
   * Reserved for inbound topic delivery (#196). Optional: drivers that
   * declare no topics omit it. The shape of {@link GatewayInboundEvent} is a
   * stub until #196 finalizes it — do not build on it outside that issue.
   */
  handleInbound?(event: GatewayInboundEvent): Promise<void>;
}
