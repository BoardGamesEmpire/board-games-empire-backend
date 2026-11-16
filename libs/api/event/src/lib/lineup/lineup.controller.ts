import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { ApiPaginatedEnvelope, paginated } from '@bge/shared';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { ListLineupQueryDto } from './dto/list-lineup.query.dto';
import { LineupService } from './lineup.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('event-lineup')
@UseGuards(PoliciesGuard)
@Controller('events/:eventId/lineup')
export class LineupController {
  constructor(private readonly lineup: LineupService) {}

  @ApiOperation({
    summary: "List an event's lineup",
    description:
      "One paged read of the event's lineup: the event's own games, and the games of each date you can read. " +
      "A row's `occurrenceId` names its date, and is `null` for the event's own games. `occurrenceId` in the " +
      "query lists one date's games alone.\n\n" +
      "Ordered by date, the dates in their own order, then the event's own games; within each, in the host's " +
      'order, then by id. Pages are offsets into a live list, so a game added or removed between requests can ' +
      'shift the rows after it.\n\n' +
      "A row's `suppliedBy` names whose offered game supplies it, and its `attendee` is `null` when you cannot " +
      "read that attendee. A row's `nominationId` links it to the nomination it came from, and is `null` for a " +
      'game added directly.',
  })
  @ApiParam({ name: 'eventId', type: String })
  @ApiPaginatedEnvelope('lineup')
  @ApiResponse({
    status: Http.BadRequest,
    description: 'A page or limit out of range, a blank `occurrenceId`, or an unknown query parameter',
  })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.EventGame))
  @Get()
  listLineup(@Param('eventId') eventId: string, @Query() query: ListLineupQueryDto) {
    return from(this.lineup.listLineup(eventId, query)).pipe(
      map((page) => paginated('lineup', page, query, ResourceType.EventGame)),
    );
  }
}
