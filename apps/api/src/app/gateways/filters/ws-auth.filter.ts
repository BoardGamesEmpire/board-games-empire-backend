import { ArgumentsHost, Catch, HttpStatus } from '@nestjs/common';
import { BaseWsExceptionFilter, WsException } from '@nestjs/websockets';
import { setTimeout } from 'node:timers/promises';
import type { Socket } from 'socket.io';

@Catch(WsException)
export class WsAuthFilter extends BaseWsExceptionFilter {
  override async catch(exception: WsException, host: ArgumentsHost): Promise<void> {
    const ws = host.switchToWs();
    const client = ws.getClient<Socket>();
    const pattern = ws.getPattern();

    if (exception.message === 'UNAUTHORIZED') {
      client.emit('auth:error', {
        pattern,
        statusText: 'UNAUTHORIZED',
        statusCode: HttpStatus.UNAUTHORIZED,
        message: exception.message ?? 'Unauthorized',
      } satisfies WsErrorResponse);

      await setTimeout(100);
      client.disconnect(true);
    } else {
      client.emit('error', {
        pattern,
        statusText: 'ERROR',
        message: exception.message ?? 'An error occurred',
      } satisfies WsErrorResponse);
    }
  }
}

interface WsErrorResponse {
  pattern: string;
  statusText: string;
  message: string | string[];
  statusCode?: number;
}
