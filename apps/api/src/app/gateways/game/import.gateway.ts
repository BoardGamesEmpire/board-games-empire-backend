import { AuthService } from '@bge/auth';
import type { ImportJobCompletedEvent, ImportJobFailedEvent } from '@bge/game-import';
import { ClientGameImportEvents, GameImportProducerService, ImportEvents, ImportStartDto } from '@bge/game-import';
import { Logger, UseFilters, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { AuthGuard } from '@thallesp/nestjs-better-auth';
import { firstValueFrom } from 'rxjs';
import { Server, Socket } from 'socket.io';
import { AuthenticatedGateway } from '../base/authenticated.gateway';
import { WsAuthFilter, WsValidationFilter } from '../filters';
import type { WsClientData } from './interfaces';

@UseGuards(AuthGuard)
@UseFilters(WsValidationFilter, WsAuthFilter)
@WebSocketGateway({
  namespace: 'games/import',
  cors: { origin: '*', credentials: true },
})
export class GameImportGateway extends AuthenticatedGateway implements OnGatewayDisconnect {
  protected readonly logger = new Logger(GameImportGateway.name);

  @WebSocketServer()
  private readonly server!: Server;

  constructor(private readonly producer: GameImportProducerService, override readonly authService: AuthService) {
    super(authService);
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
  @SubscribeMessage(ClientGameImportEvents.ImportStart)
  async handleImportStart(@ConnectedSocket() client: Socket, @MessageBody() dto: ImportStartDto): Promise<void> {
    const userId = (client.data as WsClientData).userId;
    this.logger.log(
      `Import start: socketId=${client.id} gatewayId=${dto.gatewayId} externalId=${dto.externalId} userId=${userId}`,
    );

    const result = await firstValueFrom(this.producer.enqueue(dto, userId));
    await client.join(`batch:${result.batchId}`);

    client.emit(ClientGameImportEvents.ImportQueued, {
      batchId: result.batchId,
      baseJobId: result.baseJobId,
      expansionJobIds: result.expansionJobIds,
      correlationId: dto.correlationId,
    } satisfies WsImportQueuedPayload);
  }

  @OnEvent(ImportEvents.JobCompleted, { async: true })
  onJobCompleted(event: ImportJobCompletedEvent): void {
    this.server.to(`batch:${event.batchId}`).emit(ClientGameImportEvents.ImportJobProgress, {
      batchId: event.batchId,
      jobId: event.jobId,
      gameId: event.gameId,
    } satisfies WsImportJobProgressPayload);
  }

  @OnEvent(ImportEvents.JobFailed, { async: true })
  onJobFailed(event: ImportJobFailedEvent): void {
    this.server.to(`batch:${event.batchId}`).emit(ClientGameImportEvents.ImportJobFailed, {
      batchId: event.batchId,
      jobId: event.jobId,
      error: event.error,
    } satisfies WsImportJobFailedPayload);
  }
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
