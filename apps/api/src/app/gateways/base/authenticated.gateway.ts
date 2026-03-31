import { AuthService } from '@bge/auth';
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

    client.data = {
      userId: session.user?.id,
    } satisfies BaseClientData;

    client.onAny((event, ...args) => {
      this.logger.debug(`[RAW EVENT] event=${event} args=${JSON.stringify(args)}`);
    });

    this.logger.log(`WS connected: socketId=${client.id}`);
    return session;
  }
}

export interface BaseClientData {
  userId: string;
}
