import { AuditContextInternalService } from '@bge/actor-context';
import type { BaseClientData } from '@bge/shared';
import { Injectable } from '@nestjs/common';
import type { Socket } from 'socket.io';

/**
 * Opens the CLS scope a WebSocket frame runs in, populated with the actor and
 * correlation id its connection authenticated with. The API's gateway base
 * class stores both on `Socket.data` at the handshake, and every frame is run
 * through this from a socket.io packet middleware (`socket.use`).
 *
 * A packet middleware rather than an interceptor, because of what each scope
 * covers. socket.io hands a packet to its listeners after its middleware, in a
 * `process.nextTick` that keeps the async context, so a scope opened there
 * spans Nest's whole pipeline for the frame: guards, pipes, the handler and
 * the exception filter. An interceptor's scope opens after the guards and
 * closes before the filter (#427, #498).
 *
 * It lives in this lib, not beside the gateway, because only the entry-point
 * populators may write the actor (#57).
 */
@Injectable()
export class WsActorScope {
  constructor(private readonly auditContext: AuditContextInternalService) {}

  run<T>(client: Socket, fn: () => T): T {
    const { actor, correlationId } = client.data as BaseClientData;

    return this.auditContext.runWith({ actor, correlationId, source: 'ws' }, fn);
  }
}
