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
import { ClientImportEvents, ImportEvents } from './constants/queue.constants';
import { ImportStartDto } from './dto/import-start.dto';
import type { ImportJobCompletedEvent, ImportJobFailedEvent } from './interfaces/import-job.interface';
import { GamesImportProducerService } from './services/game-import-producer.service';

@WebSocketGateway({
  namespace: 'games/import',
  cors: { origin: '*', credentials: true },
})
export class GamesImportGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(GamesImportGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  constructor(private readonly producer: GamesImportProducerService) {}

  /**
   * TODO: Authentication + authorization. Set client.data.userId here for later use in event handlers.
   */
  async handleConnection(client: Socket): Promise<void> {
    this.logger.debug(`Client connected: socketId=${client.id}`);
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
