import { AuthService } from '@bge/auth';
import type { BaseClientData } from '@bge/shared';
import { buildWsClientData } from '@bge/utils';
import { Logger, UseFilters, UseGuards } from '@nestjs/common';
import { OnGatewayConnection } from '@nestjs/websockets';
import { Http } from '@status/codes';
import { AuthGuard, type UserSession } from '@thallesp/nestjs-better-auth';
import { Socket } from 'socket.io';
import { refuseSocket, WsErrorFilter, wsErrorPayload } from '../filters';

/**
 * Authenticates a gateway's connection here, and each of its frames through
 * `AuthGuard`, answering every refusal in the #426 envelope.
 *
 * The guard and filter are bound here, not on each gateway: no app-wide
 * enhancer runs on a gateway message, so a gateway that left them out would
 * go on serving a revoked session and answer in Nest's default shape, and
 * nothing would fail. Nest reads a class's enhancers from its parents too.
 */
@UseGuards(AuthGuard)
@UseFilters(WsErrorFilter)
export abstract class AuthenticatedGateway implements OnGatewayConnection {
  protected abstract readonly logger: Logger;
  constructor(protected readonly authService: AuthService) {}

  async handleConnection(client: Socket): Promise<UserSession | void> {
    // Nest does not await this hook, so a session lookup that fails (the
    // database or Redis briefly down) would otherwise be an unhandled
    // rejection, and the socket would stay open with no actor and no answer.
    try {
      return await this.authenticate(client);
    } catch (error) {
      this.logger.error(`WS connection failed: socketId=${client.id}`, error);
      return refuseSocket(client, wsErrorPayload(Http.InternalServerError, 'Internal server error'));
    }
  }

  private async authenticate(client: Socket): Promise<UserSession | void> {
    const token = client.handshake?.auth?.token;
    this.logger.log(`WS connection attempt: socketId=${client.id} token=${token ? 'present' : 'absent'}`);

    if (!token) {
      this.logger.warn(`Unauthorized WS connection attempt: socketId=${client.id}`);
      return refuseSocket(client, wsErrorPayload(Http.Unauthorized, 'No token provided'));
    }

    const session = await this.authService.getSessionFromToken(token);
    if (!this.authService.isValidSession(session)) {
      this.logger.warn(`Invalid session for WS connection: socketId=${client.id}`);
      return refuseSocket(client, wsErrorPayload(Http.Unauthorized, 'Session expired or invalid'));
    }

    // The refusal reason comes back discriminated so the log and the
    // client-facing error both name the actual rule (#408) — an impersonated
    // session and an anonymous one are not interchangeable.
    const outcome = buildWsClientData(session, client.handshake.headers);
    if (!outcome.ok) {
      const detail = outcome.detail ? ` ${outcome.detail}` : '';
      this.logger.warn(`WS connection refused (${outcome.reason}): socketId=${client.id}${detail}`);
      return refuseSocket(client, wsErrorPayload(Http.Forbidden, outcome.message));
    }

    client.data = outcome.data satisfies BaseClientData;

    client.onAny((event, ...args) => {
      this.logger.debug(`[RAW EVENT] event=${event} args=${JSON.stringify(args)}`);
    });

    this.logger.log(
      `WS connected: socketId=${client.id} userId=${outcome.data.userId} correlationId=${outcome.data.correlationId}`,
    );
    return session;
  }
}
