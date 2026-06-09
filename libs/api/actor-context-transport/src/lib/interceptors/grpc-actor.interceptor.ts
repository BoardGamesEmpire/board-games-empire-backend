/**
 * NOT CURRENTLY WIRED. Retained as a reference implementation.
 *
 * Phase 1 of the audit/actor system has no inbound gRPC entry point that
 * needs an `external/gateway` actor — BGE's only gRPC traffic today is
 * outbound to the coordinator / gateways, where actor *propagation* (not
 * gateway identification) is the open problem.
 *
 * This file is preserved because the eventual "gateway-into-BGE" case
 * (IGDB webhook fan-out, ad-hoc enrichment pushes) will revisit this
 * shape. Specs continue to run so the reference doesn't rot.
 *
 * NOT exported from the lib's barrel. NOT registered in any module. Do
 * not register it as APP_INTERCEPTOR without first revisiting the
 * actor-propagation design pending in a future PR.
 */
import type { Actor, ActorContextInit } from '@bge/actor-context';
import { CORRELATION_ID_HEADER, TRACEPARENT_HEADER } from '@bge/shared';
import { resolveCorrelationId } from '@bge/utils';
import type { Metadata } from '@grpc/grpc-js';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { Observable } from 'rxjs';
import { ActorInterceptor } from './actor.interceptor';

/**
 * Metadata key on gRPC calls carrying the gateway identifier. Gateways
 * authenticate via the gateway registry (separate concern); by the time this
 * interceptor runs, the identity is trusted and just needs to be lifted onto
 * the actor.
 */
export const GATEWAY_ID_METADATA_KEY = 'x-bge-gateway-id' as const;

/**
 * Populates CLS actor + correlation for inbound gRPC calls. Phase 1 supports
 * gateway service-to-service calls only — `{ kind: 'external', system:
 * 'gateway', identifier }`.
 *
 * Opens its own CLS scope per call via `auditContext.runWith`. `ClsMiddleware`
 * is HTTP-only, so gRPC entry points have no outer scope to inherit from.
 * The `next.handle().subscribe(subscriber)` call happens *inside* `runWith`
 * so AsyncLocalStorage context propagates to all async emissions downstream.
 *
 * User API keys are intentionally not supported over gRPC per the locked
 * decision.
 */
@Injectable()
export class GrpcActorInterceptor extends ActorInterceptor {
  protected readonly executionContextType = 'rpc';
  protected override readonly auditSource = 'grpc';

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const metadata = executionContext.switchToRpc().getContext<{ metadata?: Metadata } | Metadata>();

    const md = this.unwrap(metadata);
    const gatewayId = this.firstMetadata(md, GATEWAY_ID_METADATA_KEY);

    if (!gatewayId) {
      throw new UnauthorizedException(`gRPC call missing '${GATEWAY_ID_METADATA_KEY}' metadata`);
    }

    const actor: Actor = {
      kind: 'external',
      system: 'gateway',
      identifier: gatewayId,
    };

    const init: ActorContextInit = {
      actor,
      correlationId: resolveCorrelationId({
        traceparent: this.firstMetadata(md, TRACEPARENT_HEADER),
        correlationId: this.firstMetadata(md, CORRELATION_ID_HEADER),
      }),
      source: this.source,
    };

    return new Observable<unknown>((subscriber) =>
      this.auditContext.runWith(init, () => next.handle().subscribe(subscriber)),
    );
  }

  private unwrap(value: { metadata?: Metadata } | Metadata | undefined): Metadata | null {
    if (!value) {
      return null;
    }
    if ('metadata' in value && value.metadata) {
      return value.metadata;
    }
    if ('get' in value && typeof value.get === 'function') {
      return value as Metadata;
    }
    return null;
  }

  private firstMetadata(metadata: Metadata | null, key: string): string | undefined {
    if (!metadata) {
      return undefined;
    }

    const values = metadata.get(key);
    const first = values[0];

    if (typeof first === 'string') {
      return first;
    }
    if (first instanceof Buffer) {
      return first.toString('utf-8');
    }
    return undefined;
  }
}
