import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Logger, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { Session } from '@thallesp/nestjs-better-auth';
import { map, tap } from 'rxjs/operators';
import { ImportStartDto } from './dto/import-start.dto';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('games/import')
@UseGuards(PoliciesGuard)
@Controller('games/import')
export class GameImportController {
  private readonly logger = new Logger(GameImportController.name);

  constructor(private readonly coordinator: GatewayCoordinatorClientService) {}

  @ApiOperation({
    summary: 'Trigger a game import from an external gateway',
    description:
      'REST fallback for the WebSocket import:start flow. Enqueues an import ' +
      'flow via the coordinator and returns batch/job IDs immediately. The actual ' +
      'fetch and persistence happen asynchronously in worker processes. Clients ' +
      'can poll job status or subscribe to WebSocket events using correlationId.',
  })
  @ApiResponse({ status: Http.Created, description: 'Import enqueued successfully' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.Game))
  @Post()
  startImport(@Session() session: UserSession, @Body() dto: ImportStartDto) {
    this.logger.log(`REST import: user=${session.user.id} gateway=${dto.gatewayId} externalId=${dto.externalId}`);

    return this.coordinator
      .startGameImport({
        correlationId: dto.correlationId,
        gatewayId: dto.gatewayId,
        externalId: dto.externalId,
        expansionExternalIds: dto.expansionExternalIds ?? [],
        locale: dto.locale,
        userId: session.user.id,
      })
      .pipe(
        tap((result) => this.logger.log(`Import enqueued: batchId=${result.batchId} baseJobId=${result.baseJobId}`)),
        map((result) => ({
          message: 'Import enqueued',
          batchId: result.batchId,
          baseJobId: result.baseJobId,
          expansionJobIds: result.expansionJobIds,
          correlationId: dto.correlationId,
        })),
      );
  }
}
