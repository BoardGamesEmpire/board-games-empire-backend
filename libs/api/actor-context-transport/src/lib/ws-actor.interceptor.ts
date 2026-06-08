import { AuditContextInternalService } from '@bge/actor-context/internal';
import type { BaseClientData } from '@bge/shared';
import { type CallHandler, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Socket } from 'socket.io';
import { ActorInterceptor } from './actor.interceptor';

/**
 * Populates CLS actor + correlation context for WebSocket message handlers.
 *
 * Auth and actor resolution happen *at connection time* in
 * `AuthenticatedGateway.handleConnection`, which stashes a `BaseClientData`
 * payload on `Socket.data`. This interceptor reads that payload on every
 * incoming message and opens the per-message CLS scope.
 *
 * No-op for non-WS execution contexts so it's safe to register globally
 * alongside `HttpActorInterceptor` and `GrpcActorInterceptor`.
 *
 * Defensive case: if `socket.data` isn't populated (the connection somehow
 * bypassed the gateway base class), the interceptor logs an error and
 * proceeds without populating CLS. Downstream audit emissions will see no
 * actor; Phase 2's audit listener guards against this and treats it as a
 * skip.
 */
@Injectable()
export class WsActorInterceptor extends ActorInterceptor {
  protected readonly executionContextType = 'ws';

  constructor(auditContext: AuditContextInternalService) {
    super(auditContext);
  }

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const client = executionContext.switchToWs().getClient<Socket>();
    const data = client.data as Partial<BaseClientData> | undefined;

    if (!data?.actor || !data.correlationId) {
      this.logger.error(
        `WS message handled without populated client.data; socketId=${client.id}. ` +
          'AuthenticatedGateway must run before this interceptor.',
      );
      return next.handle();
    }

    this.auditContext.populate({
      actor: data.actor,
      correlationId: data.correlationId,
      source: this.source,
    });

    return next.handle();
  }
}
