import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Get, Logger, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { Session } from '@thallesp/nestjs-better-auth';
import { from } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { DefaultPaginationQueryDto } from '@bge/shared';
import { ImportStartDto } from './dto/import-start.dto';
import { ImportBatchListResponseDto, ImportBatchStatusResponseDto } from './dto/import-status.dto';
import { GameImportStatusService } from './services/import-status.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('games/import')
@UseGuards(PoliciesGuard)
@Controller('games/import')
export class GameImportController {
  private readonly logger = new Logger(GameImportController.name);

  constructor(
    private readonly coordinator: GatewayCoordinatorClientService,
    private readonly importStatus: GameImportStatusService,
  ) {}

  @ApiOperation({
    summary: 'Trigger a game import from an external gateway',
    description:
      'Enqueues an import flow via the coordinator and returns batch/job IDs ' +
      'immediately. The actual fetch and persistence happen asynchronously in ' +
      'worker processes. Poll GET /games/import/{batchId} to observe progress ' +
      'and, on completion, obtain the persisted gameId and platformGameIds.',
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
          correlationId: result.correlationId,
        })),
      );
  }

  @ApiOperation({
    summary: 'List your import batches',
    description:
      'Returns the import batches started by the authenticated user, most ' +
      'recent first, each with per-job states and the derived rollup. Use ' +
      'this to recover batch/job ids no longer held client-side (page ' +
      'refresh, reinstall) — they are otherwise only returned when the ' +
      'import is started.',
  })
  @ApiResponse({ status: Http.Ok, type: ImportBatchListResponseDto })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Job))
  @Get()
  listImports(@Session() session: UserSession, @Query() pagination: DefaultPaginationQueryDto) {
    return from(this.importStatus.listBatchesForUser(session.user.id, pagination));
  }

  @ApiOperation({
    summary: 'Poll the status of an async game import',
    description:
      'Returns the per-job states of an import batch plus a derived batch ' +
      'rollup. Once a job reaches Completed its entry carries the persisted ' +
      'gameId and the platformGameIds that collections key on. Pending/Running ' +
      'have no server-side timeout; clients should apply their own polling deadline.',
  })
  @ApiParam({ name: 'batchId', type: String, format: 'uuid', description: 'batchId returned by POST /games/import' })
  @ApiResponse({ status: Http.Ok, type: ImportBatchStatusResponseDto })
  @ApiResponse({ status: Http.BadRequest, description: 'Malformed batchId (not a UUID)' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Unknown batchId' })
  // Deliberately NOT owner-scoped: imported games are public content, so any
  // authenticated reader may poll any batch by id (mirrors the public
  // ImportActivity feed; batch ids are unguessable UUIDs). The user-scoped
  // view is the list route above.
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Job))
  @Get(':batchId')
  getImportStatus(@Param('batchId', ParseUUIDPipe) batchId: string) {
    return from(this.importStatus.getBatchStatus(batchId));
  }
}
