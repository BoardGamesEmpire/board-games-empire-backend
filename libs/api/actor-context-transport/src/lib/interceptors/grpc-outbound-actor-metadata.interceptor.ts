import { getActorSnapshotFromCls } from '@bge/actor-context';
import { BGE_ACTOR_HEADER, CORRELATION_ID_HEADER } from '@bge/shared';
import { InterceptingCall, type Interceptor, type InterceptorOptions, Metadata, type NextCall } from '@grpc/grpc-js';
import { Logger } from '@nestjs/common';

/**
 * Mutates the supplied outbound gRPC {@link Metadata} in place with the
 * current BGE audit context — actor (full identity, base64-encoded JSON)
 * and correlation ID. Extracted from the interceptor factory so the
 * decision tree is unit-testable in isolation, without instantiating
 * grpc-js `InterceptingCall` machinery.
 *
 * No-op when the CLS has no audit context active. System-originated code
 * paths (health pings, scheduled tasks, bootstrap discovery) MUST enter a
 * CLS scope explicitly via `SystemActorScope.run` / `runObservable` from
 * `@bge/actor-context` — never rely on a fallback here. A missing actor
 * at the outbound side is intentionally caught by the receiver's strict
 * inbound interceptor, surfacing the bug rather than masking it.
 *
 * NOTE: trace context propagation (`traceparent` / `tracestate`) is the
 * job of OTel's `@opentelemetry/instrumentation-grpc`, which patches
 * grpc-js to inject those headers automatically. This helper deliberately
 * does NOT touch them — doubling up would corrupt the trace.
 */
export function injectActorContextMetadata(metadata: Metadata): void {
  const snapshot = getActorSnapshotFromCls();

  if (snapshot.actor) {
    const encoded = Buffer.from(JSON.stringify(snapshot.actor), 'utf8').toString('base64');
    metadata.set(BGE_ACTOR_HEADER, encoded);
  }

  if (snapshot.correlationId) {
    metadata.set(CORRELATION_ID_HEADER, snapshot.correlationId);
  }
}

/**
 * Constructs a grpc-js client `Interceptor` that injects BGE audit
 * context into every outbound gRPC call's metadata.
 *
 * Wire by passing the result into the gRPC client's `channelOptions`
 * (NestJS forwards this to grpc-js's `Client` constructor, which accepts
 * an `interceptors` array at the `ClientOptions` level):
 *
 * ```ts
 * ClientsModule.registerAsync({
 *   clients: [{
 *     transport: Transport.GRPC,
 *     options: {
 *       channelOptions: {
 *         interceptors: [createOutboundActorMetadataInterceptor()],
 *       },
 *     },
 *   }],
 * })
 * ```
 *
 * The returned interceptor is stateless and safe to share across calls
 * within a client; each call gets its own `InterceptingCall` instance.
 *
 * Failure isolation: if {@link injectActorContextMetadata} throws (e.g.,
 * CLS service unavailable during shutdown), the interceptor logs a
 * warning and forwards the call with whatever metadata was already set.
 * RPC must never fail because of audit-context propagation problems.
 */
export function createOutboundActorMetadataInterceptor(): Interceptor {
  const logger = new Logger('OutboundActorMetadataInterceptor');

  return (options: InterceptorOptions, nextCall: NextCall) =>
    new InterceptingCall(nextCall(options), {
      start: (metadata, listener, next) => {
        try {
          injectActorContextMetadata(metadata);
        } catch (error) {
          logger.warn(`Failed to inject actor context into outbound gRPC metadata: ${(error as Error).message}`);
        }
        next(metadata, listener);
      },
    });
}
