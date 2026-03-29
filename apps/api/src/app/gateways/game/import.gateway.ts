import { AuthService } from '@bge/auth';
import type { ImportJobCompletedEvent, ImportJobFailedEvent } from '@bge/game-import';
import { ClientImportEvents, GameImportProducerService, ImportEvents, ImportStartDto } from '@bge/game-import';
import { Logger, UsePipes, ValidationPipe } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { firstValueFrom } from 'rxjs';
import { Server, Socket } from 'socket.io';

@WebSocketGateway({
  namespace: 'games/import',
  cors: { origin: '*', credentials: true },
})
export class GameImportGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(GameImportGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  constructor(private readonly producer: GameImportProducerService, private readonly authService: AuthService) {}

  async handleConnection(client: Socket): Promise<void> {
    const token = client.handshake?.auth?.token;
    this.logger.log(`WS connection attempt: socketId=${client.id} token=${token ? 'present' : 'absent'}`);

    if (!token) {
      this.logger.warn(`Unauthorized WS connection attempt: socketId=${client.id}`);
      client.disconnect(true);
      return;
    }

    const session = await this.authService.getSessionFromToken(token);
    if (this.authService.validateSession(session)) {
      this.logger.warn(`Invalid session for WS connection: socketId=${client.id}`);
      client.disconnect(true);
      return;
    }

    this.logger.log(`WS connected: socketId=${client.id}`);
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug(`Client disconnected: socketId=${client.id}`);
  }

  @UsePipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  )
  @SubscribeMessage(ClientImportEvents.ImportStart)
  async handleImportStart(@ConnectedSocket() client: Socket, @MessageBody() dto: ImportStartDto): Promise<void> {
    const userId = (client.data as WsClientData).userId;
    this.logger.log(`Import start: socketId=${client.id} gatewayId=${dto.gatewayId} externalId=${dto.externalId}`);

    const result = await firstValueFrom(this.producer.enqueue(dto, userId));
    await client.join(`batch:${result.batchId}`);

    client.emit(ClientImportEvents.ImportQueued, {
      batchId: result.batchId,
      baseJobId: result.baseJobId,
      expansionJobIds: result.expansionJobIds,
      correlationId: dto.correlationId,
    } satisfies WsImportQueuedPayload);
  }

  @OnEvent(ImportEvents.JobCompleted, { async: true })
  onJobCompleted(event: ImportJobCompletedEvent): void {
    this.server.to(`batch:${event.batchId}`).emit(ClientImportEvents.ImportJobProgress, {
      batchId: event.batchId,
      jobId: event.jobId,
      gameId: event.gameId,
    } satisfies WsImportJobProgressPayload);
  }

  @OnEvent(ImportEvents.JobFailed, { async: true })
  onJobFailed(event: ImportJobFailedEvent): void {
    this.server.to(`batch:${event.batchId}`).emit(ClientImportEvents.ImportJobFailed, {
      batchId: event.batchId,
      jobId: event.jobId,
      error: event.error,
    } satisfies WsImportJobFailedPayload);
  }
}

interface WsClientData {
  userId: string | null;
}

interface WsImportQueuedPayload {
  batchId: string;
  baseJobId: string;
  expansionJobIds: string[];
  correlationId: string;
}

interface WsImportJobProgressPayload {
  batchId: string;
  jobId: string;
  gameId: string;
}

interface WsImportJobFailedPayload {
  batchId: string;
  jobId: string;
  error: string;
}
