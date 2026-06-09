import { type ActorContextInit } from '@bge/actor-context';
import type { BaseClientData } from '@bge/shared';
import { type CallHandler, type ExecutionContext, Injectable } from '@nestjs/common';
import { Observable } from 'rxjs';
import type { Socket } from 'socket.io';
import { ActorInterceptor } from './actor.interceptor';

/**
 * Populates CLS actor + correlation context for WebSocket message handlers.
 *
 * Auth and actor resolution happen *at connection time* in
 * `AuthenticatedGateway.handleConnection`, which stashes a `BaseClientData`
 * payload on `Socket.data`. This interceptor reads that payload on every
 * incoming message and opens a per-message CLS scope via `runWith`.
 *
 * `ClsMiddleware` is HTTP-only, so WS handlers have no outer scope to
 * inherit from. Opening the scope here — with `next.handle().subscribe(...)`
 * called inside `runWith` — ensures AsyncLocalStorage context propagates to
 * all async emissions during message handling.
 *
 * No-op for non-WS execution contexts so it's safe to register globally
 * alongside `HttpActorInterceptor` and `GrpcActorInterceptor`.
 *
 * Defensive case: if `socket.data` isn't populated (the connection somehow
 * bypassed the gateway base class), the interceptor logs an error and
 * passes the call through without opening a scope. Downstream audit
 * emissions will see no actor; Phase 2's audit listener guards against
 * this and treats it as a skip.
 */
@Injectable()
export class WsActorInterceptor extends ActorInterceptor {
  protected readonly executionContextType = 'ws';

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const client = executionContext.switchToWs().getClient<Socket>();
    const data = client.data as Partial<BaseClientData> | undefined;

    if (!data?.actor || !data.correlationId) {
      this.logger.error(
        `WS message handled without populated client.data; socketId=${client.id}. ` +
          'AuthenticatedGateway must populate client.data before this interceptor runs.',
      );
      return next.handle();
    }

    const init: ActorContextInit = {
      actor: data.actor,
      correlationId: data.correlationId,
      source: this.source,
    };

    return new Observable<unknown>((subscriber) =>
      this.auditContext.runWith(init, () => next.handle().subscribe(subscriber)),
    );
  }
}
