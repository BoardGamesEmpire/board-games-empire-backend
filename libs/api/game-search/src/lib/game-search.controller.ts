import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Controller, Get, Logger, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { SearchQueryDto } from './dto/search-query.dto';
import { SearchResponseDto } from './dto/search-response.dto';
import { GameSearchService } from './game-search.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('games/search')
@UseGuards(PoliciesGuard)
@Controller('games/search')
export class GameSearchController {
  private readonly logger = new Logger(GameSearchController.name);

  constructor(private readonly gameSearchService: GameSearchService) {}

  @ApiOperation({
    summary: 'Search games across local DB and external gateways',
    description:
      'REST fallback for the WebSocket search:start flow. ' +
      'Collects all results from local DB and coordinator unary gRPC into a single response. ' +
      'The local half matches titles within the set `GET /games` lists: the live Public games and the ' +
      'caller’s own, the same set for every caller. **Breaking change (#513).** Owner/Admin/Moderator ' +
      'previously also found every private game on the server; one they can read is still readable at ' +
      '`GET /games/:id`. An **API key** is additionally floored by its own permissions (effective access is ' +
      'key ∩ owner).',
  })
  @ApiResponse({ status: 200, type: SearchResponseDto })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({
    status: 403,
    description:
      'Insufficient permissions, or, when the local half is asked for, an actor kind with no games of its ' +
      'own (plugin, system, external) — new with #513, and provisional: see #395',
  })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Game))
  @Get()
  search(@Query() dto: SearchQueryDto) {
    this.logger.debug(`REST search: query="${dto.query}" gateways=[${dto.gatewayIds?.join(',') ?? ''}]`);
    return this.gameSearchService.search(dto);
  }
}
