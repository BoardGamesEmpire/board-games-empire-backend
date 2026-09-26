import { AuditContextService } from '@bge/actor-context';
import { WsActorScope } from '@bge/actor-context-transport';
import { AbilityService } from '@bge/permissions';
import { type CanActivate, Injectable } from '@nestjs/common';
import type { Socket } from 'socket.io';

/**
 * Runs each of a socket's frames inside its connection's actor scope, with
 * that actor's abilities primed, the way HTTP runs each request.
 */
@Injectable()
export class WsFrameScope {
  constructor(
    private readonly actorScope: WsActorScope,
    private readonly abilityService: AbilityService,
    private readonly auditContext: AuditContextService,
  ) {}

  /**
   * Opens the scope around every frame an authenticated socket sends. Called
   * once `client.data` holds the connection's actor.
   */
  bind(client: Socket): void {
    client.use((_packet, next) => this.actorScope.run(client, () => next()));
  }

  /**
   * Primes the current frame's abilities. They are resolved for each frame,
   * never kept on the socket, so a grant revoked while the socket stays open
   * counts from its next frame.
   */
  async prime(): Promise<void> {
    if (!this.auditContext.getActor()) {
      throw new Error('WebSocket frame is not running as an actor');
    }

    await this.abilityService.primeCurrentActor();
  }
}

/**
 * Primes each frame's abilities, after `AuthGuard` has found the frame's
 * session still live and before `PoliciesGuard` reads them.
 *
 * A guard rather than part of the packet middleware: guards run only for a
 * frame some handler listens for, so a client sending made-up events buys no
 * permission lookup with them, and a failure reaches the gateway's exception
 * filter like any other refusal. After `AuthGuard`, so a frame whose session
 * has ended is refused for that before any of its abilities are looked up.
 *
 * It also refuses a frame that does not run inside its connection's actor
 * scope, which `AuthenticatedGateway` should make impossible. A subclass that
 * overrides the base's hooks without calling them skips the scope silently,
 * but it cannot drop a guard the base class declares. That refusal is a plain
 * `Error`, a fault of the server's rather than the client's, so
 * `WsErrorFilter` logs it and answers 500.
 */
@Injectable()
export class WsFrameScopeGuard implements CanActivate {
  constructor(private readonly frameScope: WsFrameScope) {}

  async canActivate(): Promise<boolean> {
    await this.frameScope.prime();

    return true;
  }
}
