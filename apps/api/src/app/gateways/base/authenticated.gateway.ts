import { AuthService } from '@bge/auth';
import type { BaseClientData } from '@bge/shared';
import { buildWsClientData } from '@bge/utils';
import { Logger } from '@nestjs/common';
import { OnGatewayConnection } from '@nestjs/websockets';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { setTimeout } from 'node:timers/promises';
import { Socket } from 'socket.io';

export abstract class AuthenticatedGateway implements OnGatewayConnection {
  protected abstract readonly logger: Logger;
  constructor(protected readonly authService: AuthService) {}

  async handleConnection(client: Socket): Promise<UserSession | void> {
    const token = client.handshake?.auth?.token;
    this.logger.log(`WS connection attempt: socketId=${client.id} token=${token ? 'present' : 'absent'}`);

    if (!token) {
      this.logger.warn(`Unauthorized WS connection attempt: socketId=${client.id}`);
      client.emit('auth:error', { status: 'UNAUTHORIZED', message: 'No token provided' });
      await setTimeout(100);
      client.disconnect(true);
      return;
    }

    const session = await this.authService.getSessionFromToken(token);
    if (!this.authService.isValidSession(session)) {
      this.logger.warn(`Invalid session for WS connection: socketId=${client.id}`);
      client.emit('auth:error', { status: 'UNAUTHORIZED', message: 'Session expired or invalid' });
      await setTimeout(100);
      client.disconnect(true);
      return;
    }

    // The refusal reason comes back discriminated so the log and the
    // client-facing error both name the actual rule (#408) — an impersonated
    // session and an anonymous one are not interchangeable.
    const outcome = buildWsClientData(session, client.handshake.headers);
    if (!outcome.ok) {
      const detail = outcome.detail ? ` ${outcome.detail}` : '';
      this.logger.warn(`WS connection refused (${outcome.reason}): socketId=${client.id}${detail}`);
      client.emit('auth:error', { status: 'FORBIDDEN', message: outcome.message });
      await setTimeout(100);
      client.disconnect(true);
      return;
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
