import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { map, tap } from 'rxjs/operators';
import { ImportStartDto } from './dto/import-start.dto';
import { GameImportProducerService, type EnqueueResult } from './services/game-import-producer.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('games/import')
@UseGuards(PoliciesGuard)
@Controller('games/import')
export class GameImportController {
  private readonly logger = new Logger(GameImportController.name);

  constructor(private readonly importProducer: GameImportProducerService) {}

  @ApiOperation({
    summary: 'Trigger a game import from an external gateway',
    description:
      'REST fallback for the WebSocket import:start flow. ' +
      'Fetches the game via the coordinator, enqueues the import job, and returns the batch/job IDs. ' +
      'Clients can poll job status or subscribe to WebSocket events using the returned correlationId.',
  })
  @ApiResponse({ status: 201, description: 'Import enqueued successfully' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @ApiResponse({ status: 404, description: 'Game not found on the specified gateway' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.Game))
  @Post()
  startImport(@Session() session: UserSession, @Body() dto: ImportStartDto) {
    this.logger.log(`REST import: user=${session.user.id} gateway=${dto.gatewayId} externalId=${dto.externalId}`);

    return this.importProducer.enqueue(dto, session.user.id).pipe(
      tap((result: EnqueueResult) =>
        this.logger.log(`Import enqueued: batchId=${result.batchId} baseJobId=${result.baseJobId}`),
      ),
      map((result: EnqueueResult) => ({
        message: 'Import enqueued',
        batchId: result.batchId,
        baseJobId: result.baseJobId,
        expansionJobIds: result.expansionJobIds,
        correlationId: dto.correlationId,
      })),
    );
  }
}
