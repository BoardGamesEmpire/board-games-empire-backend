import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { ApiPaginatedEnvelope, DefaultPaginationQueryDto, paginated } from '@bge/shared';
import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { AddAttendeeDto } from './dto/add-attendee.dto';
import { AddGameToListDto } from './dto/add-game-to-list.dto';
import { UpdateAttendeeStatusDto } from './dto/update-attendee-status.dto';
import { EventAttendeeService } from './event-attendee.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('event-attendees')
@UseGuards(PoliciesGuard)
@Controller('events/:eventId/attendees')
export class EventAttendeeController {
  private readonly logger = new Logger(EventAttendeeController.name);

  constructor(private readonly attendeeService: EventAttendeeService) {}

  @ApiOperation({
    summary: 'List attendees for an event',
    description:
      'In the order attendees were first added, then id; an attendee added again keeps their first place. ' +
      '**Paginated since #373**, this read used to return every attendee of the event: `?page=` (1-based) and ' +
      '`?limit=`, with a `pagination` envelope carrying `total`, `totalPages` and `hasMore`. A client that assumed ' +
      'one complete list must now page. Pages are offsets into a live list, so an attendee removed or added again ' +
      'between requests can shift the rows after them, and a row can be missed or repeated.',
  })
  @ApiParam({ name: 'eventId', type: String })
  @ApiPaginatedEnvelope('attendees')
  @ApiResponse({ status: Http.BadRequest, description: 'A page or limit out of range, or an unknown query parameter' })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.EventAttendee))
  @Get()
  getAttendees(@Param('eventId') eventId: string, @Query() pagination: DefaultPaginationQueryDto) {
    return from(this.attendeeService.getAttendees(eventId, pagination)).pipe(
      map((page) => paginated('attendees', page, pagination, ResourceType.EventAttendee)),
    );
  }

  @ApiOperation({ summary: 'Get a single attendee' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'attendeeId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Attendee retrieved' })
  @ApiResponse({ status: Http.NotFound, description: 'Attendee or event not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.EventAttendee))
  @Get(':attendeeId')
  getAttendee(@Param('eventId') eventId: string, @Param('attendeeId') attendeeId: string) {
    return from(this.attendeeService.getAttendee(eventId, attendeeId)).pipe(map((attendee) => ({ attendee })));
  }

  @ApiOperation({ summary: 'Add an attendee to an event' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiResponse({ status: Http.Created, description: 'Attendee added' })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      'No attendee grant on this event, or a co-host, organizer or moderator role from an organizer or moderator: ' +
      "only the event's host or co-host, or an owner or admin of its household, gives those out",
  })
  @ApiResponse({ status: Http.Conflict, description: 'User is already an attendee' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.EventAttendee))
  @Post()
  addAttendee(@Param('eventId') eventId: string, @Body() dto: AddAttendeeDto) {
    return from(this.attendeeService.addAttendee(eventId, dto)).pipe(
      tap((attendee) => this.logger.log(`Attendee ${attendee.id} added to event ${eventId}`)),
      map((attendee) => ({ message: t('success.attendee.added'), attendee })),
    );
  }

  @ApiOperation({
    summary: 'Remove an attendee from an event',
    description:
      'Marks the attendee removed and deletes their event role. Their votes are kept and stop counting; the nominations of games they offered pause, and the games they supply leave the lineup. Adding the same user again revives the row.',
  })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'attendeeId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Attendee removed' })
  @ApiResponse({ status: Http.NotFound, description: 'Attendee not found, or already removed' })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      'No attendee grant on this event, or an organizer or moderator removing a host, co-host, organizer or moderator',
  })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.EventAttendee))
  @Delete(':attendeeId')
  removeAttendee(@Param('eventId') eventId: string, @Param('attendeeId') attendeeId: string) {
    return from(this.attendeeService.removeAttendee(eventId, attendeeId)).pipe(
      tap(() => this.logger.log(`Attendee ${attendeeId} removed from event ${eventId}`)),
      map((attendee) => ({
        message: t('success.attendee.removed'),
        attendee,
      })),
    );
  }

  @ApiOperation({ summary: 'Update attendee status (RSVP)' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'attendeeId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Status updated' })
  @ApiResponse({ status: Http.NotFound, description: 'Attendee not found' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.EventAttendee))
  @Patch(':attendeeId/status')
  updateStatus(
    @Param('eventId') eventId: string,
    @Param('attendeeId') attendeeId: string,
    @Body() dto: UpdateAttendeeStatusDto,
  ) {
    return from(this.attendeeService.updateStatus(eventId, attendeeId, dto)).pipe(
      map((attendee) => ({
        message: t('success.attendee.status_updated'),
        attendee,
      })),
    );
  }

  @ApiOperation({ summary: "Get an attendee's available game list" })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'attendeeId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Game list retrieved' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.EventAttendeeGameList))
  @Get(':attendeeId/games')
  getGameList(@Param('eventId') eventId: string, @Param('attendeeId') attendeeId: string) {
    return from(this.attendeeService.getGameList(eventId, attendeeId)).pipe(map((games) => ({ games })));
  }

  @ApiOperation({ summary: "Add a game to an attendee's available list" })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'attendeeId', type: String })
  @ApiResponse({ status: Http.Created, description: 'Game added to list' })
  @ApiResponse({ status: Http.Conflict, description: 'Game already in list' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.EventAttendeeGameList))
  @Post(':attendeeId/games')
  addGameToList(
    @Param('eventId') eventId: string,
    @Param('attendeeId') attendeeId: string,
    @Body() dto: AddGameToListDto,
  ) {
    return from(this.attendeeService.addGameToList(eventId, attendeeId, dto)).pipe(
      map((entry) => ({ message: t('success.attendee.game_added'), entry })),
    );
  }

  @ApiOperation({ summary: "Remove a game from an attendee's available list" })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'attendeeId', type: String })
  @ApiParam({ name: 'gameListId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Game removed from list' })
  @ApiResponse({ status: Http.NotFound, description: 'Game list entry not found' })
  @ApiResponse({
    status: Http.Conflict,
    description: 'The game supplies a nomination awaiting an outcome, or a game in the lineup',
  })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.EventAttendeeGameList))
  @Delete(':attendeeId/games/:gameListId')
  removeGameFromList(
    @Param('eventId') eventId: string,
    @Param('attendeeId') attendeeId: string,
    @Param('gameListId') gameListId: string,
  ) {
    return from(this.attendeeService.removeGameFromList(eventId, attendeeId, gameListId)).pipe(
      map((entry) => ({ message: t('success.attendee.game_removed'), entry })),
    );
  }
}
