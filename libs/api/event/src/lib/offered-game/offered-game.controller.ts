import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { ApiPaginatedEnvelope, paginated } from '@bge/shared';
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { ListOfferedGamesQueryDto } from './dto/list-offered-games.query.dto';
import { OfferedGameService } from './offered-game.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('event-offered-games')
@UseGuards(PoliciesGuard)
@Controller('events/:eventId/offered-games')
export class OfferedGameController {
  constructor(private readonly offeredGames: OfferedGameService) {}

  @ApiOperation({
    summary: "List the games an event's attendees offer",
    description:
      'One paged read of every game offered to the event. A row is one offered entry: two attendees offering the ' +
      "same game give two rows, each with its own `attendeeId`. A row carries the game, the offered copy's medium " +
      'and platform, the base games an expansion plays with, and `supplies`: the open nominations naming the entry ' +
      'and its lineup games still ahead, each `null` when you cannot read that kind of record. Its `attendee` is ' +
      '`null` when you cannot read that attendee. Its `onWishlist` says whether the game, or that platform game, ' +
      'is on your own wishlist, and is `null` rather than `false` when this request cannot read your wishlist.\n\n' +
      'Ordered by game title, then entry id. Games taken back, and every game of an attendee removed from ' +
      'the event, are left out of the rows and the `total`. An attendee answering Not attending keeps their rows, ' +
      'and their `attendee.status` says so: their games cannot be nominated.\n\n' +
      'Every filter given is ANDed with the others. Each list takes an include and an exclude parameter, and both ' +
      "can be given at once: `excludeAttendeeIds=<your attendee id>` lists everyone's games but yours. Pages are " +
      'offsets into a live list, so a game offered or taken back between requests can shift the rows after it.',
  })
  @ApiParam({ name: 'eventId', type: String })
  @ApiPaginatedEnvelope('offeredGames')
  @ApiResponse({
    status: Http.BadRequest,
    description: 'A filter, page or limit out of range, an empty list, or an unknown query parameter',
  })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.EventAttendeeGameList))
  @Get()
  listOfferedGames(@Param('eventId') eventId: string, @Query() query: ListOfferedGamesQueryDto) {
    return from(this.offeredGames.listOfferedGames(eventId, query)).pipe(
      map((page) => paginated('offeredGames', page, query, ResourceType.EventAttendeeGameList)),
    );
  }
}
