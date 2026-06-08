import type { Actor } from '@bge/actor-context';
import { AuditContextInternalService } from '@bge/actor-context/internal';
import { CORRELATION_ID_HEADER, TRACEPARENT_HEADER } from '@bge/shared';
import { resolveCorrelationId } from '@bge/utils';
import type { Metadata } from '@grpc/grpc-js';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Observable } from 'rxjs';
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
 * Gateway identity is read from metadata. Authentication itself is performed
 * upstream by the gateway registry layer; this interceptor trusts the
 * metadata.
 *
 * User API keys are intentionally not supported over gRPC per the locked
 * decision (gateways are the only gRPC consumer in Phase 1).
 */
@Injectable()
export class GrpcActorInterceptor extends ActorInterceptor {
  protected readonly executionContextType = 'rpc';
  protected override readonly auditSource = 'grpc';

  constructor(auditContext: AuditContextInternalService) {
    super(auditContext);
  }

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

    this.logger.debug(`Populating gRPC actor context: gatewayId=${gatewayId}`);

    this.auditContext.populate({
      actor,
      correlationId: resolveCorrelationId({
        traceparent: this.firstMetadata(md, TRACEPARENT_HEADER),
        correlationId: this.firstMetadata(md, CORRELATION_ID_HEADER),
      }),
      source: this.source,
    });

    return next.handle();
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
