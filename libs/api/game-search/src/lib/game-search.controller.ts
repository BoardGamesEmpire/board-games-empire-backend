import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Controller, Get, Logger, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { SearchQueryDto } from './dto/search-query.dto';
import { SearchResponseDto } from './dto/search-response.dto';
import { GameSearchService } from './game-search.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('game-search')
@UseGuards(PoliciesGuard)
@Controller('games/search')
export class GameSearchController {
  private readonly logger = new Logger(GameSearchController.name);

  constructor(private readonly gameSearchService: GameSearchService) {}

  @ApiOperation({
    summary: 'Search games across local DB and external gateways',
    description:
      'REST fallback for the WebSocket search:start flow. ' +
      'Collects all results from local DB and coordinator unary gRPC into a single response.',
  })
  @ApiResponse({ status: 200, type: SearchResponseDto })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Game))
  @Get()
  search(@Query() dto: SearchQueryDto) {
    this.logger.debug(`REST search: query="${dto.query}" gateways=[${dto.gatewayIds?.join(',') ?? ''}]`);
    return this.gameSearchService.search(dto);
  }
}
