import { ArgumentsHost, BadRequestException, Catch } from '@nestjs/common';
import { BaseWsExceptionFilter } from '@nestjs/websockets';
import { Http } from '@status/codes';
import type { Socket } from 'socket.io';

@Catch(BadRequestException)
export class WsValidationFilter extends BaseWsExceptionFilter {
  override catch(exception: BadRequestException, host: ArgumentsHost): void {
    const ws = host.switchToWs();
    const client = ws.getClient<Socket>();
    const pattern = ws.getPattern();
    const response = exception.getResponse() as { message: string | string[] };

    client.emit(`${pattern}:error`, {
      pattern,
      statusText: 'BAD_REQUEST',
      statusCode: Http.BadRequest,
      message: response.message ?? 'Validation failed',
    } satisfies ValidationErrorResponse);
  }
}

interface ValidationErrorResponse {
  pattern: string;
  statusText: string;
  message: string | string[];
  statusCode?: number;
}
