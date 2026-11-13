import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { ApiPaginatedEnvelope, DefaultPaginationQueryDto, paginated } from '@bge/shared';
import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { CreateEventDto } from './dto/create-event.dto';
import { ListEventsQueryDto } from './dto/list-events.query.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventService } from './event.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('events')
@UseGuards(PoliciesGuard)
@Controller('events')
export class EventController {
  private readonly logger = new Logger(EventController.name);

  constructor(private readonly eventService: EventService) {}

  @ApiOperation({
    summary: 'List events the caller is an attendee of',
    description:
      'Attendance-scoped: events the caller holds an attendee row for, hosts included, and nothing else — the ' +
      'same kind of result for every caller. The row counts whatever its RSVP status, so events the caller is ' +
      'only invited to, or has declined, are listed too. Newest first, soft-deleted events excluded. ' +
      'Archived events are left out unless `?includeArchived=true`, and stay readable by id (#795). Each event ' +
      'carries a `status` worked out from its cancel, archive and confirmed dates. Each event carries `attendance`, ' +
      'the acting user\u2019s own attendee row: `attendeeId`, `status` (their RSVP), `role` and `rsvpDate`. It is ' +
      '`null` when the actor can\u2019t read that row, as with an API key without permission to read attendees. ' +
      '**Breaking change (#512).** This route previously widened with the caller: a household member also received every event ' +
      'in their households, a friend received the events whose reach admits friends, and Owner/Admin/Moderator ' +
      'received every event on the server, with `pagination.total` scoped the same way (#365). Each of those ' +
      'events is still readable at `GET /events/:id`. An **API key** is additionally floored by its own ' +
      'permissions (effective access is key ∩ owner). Paginated: `?page=` (1-based) and `?limit=`, with a ' +
      '`pagination` envelope carrying `total`, `totalPages` and `hasMore`; `total` counts the caller\u2019s ' +
      'visible events. See #230; the row shape is modelled in #402.',
  })
  @ApiPaginatedEnvelope('events')
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      'Insufficient permissions, or an actor kind with no attendance of its own (plugin, system, external) ' +
      '— new with #512, and provisional: see #395',
  })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Event))
  @Get()
  getEvents(@Query() query: ListEventsQueryDto) {
    return from(this.eventService.getEvents(query)).pipe(
      map((page) => paginated('events', page, query, ResourceType.Event)),
    );
  }

  // Declared above `:id`, which would otherwise read `browse` as an event id.
  @ApiOperation({
    summary: "List upcoming events the acting user can read but doesn't attend",
    description:
      'Events the acting user could join (#962): public events, a friend’s events that reach friends, a ' +
      'friend of a friend’s events that reach friends of friends, the events of users up to three ' +
      'friendship steps away that reach the extended network (#497), and the events of the acting user’s ' +
      'households. A public event is left out when either the acting user or its host has blocked the other; ' +
      'it stays readable by id. An event the acting user has any attendee row on is left out, whether they ' +
      'host it, were invited, declined or were removed. Only upcoming events are listed: not cancelled, ' +
      'archived or deleted, with a confirmed date that hasn’t ended, so each `status` is Scheduled or ' +
      'Ongoing. A date with no end ends when it starts. Events with no date yet are left out. Soonest first: ' +
      'by the start of each event’s earliest date that hasn’t ended, then by id. Each row is a ' +
      '`GET /events` row, and `attendance` is always `null`, since the acting user has no row on these events. The Owner, Admins and Moderators get the same kind of list as everyone else, not ' +
      'every event on the server. An **API key** is also limited by its own permissions (effective access ' +
      'is key ∩ owner). Nobody can join an event from this list yet; that is #812. Paginated: `?page=` ' +
      '(1-based) and `?limit=`, with a `pagination` envelope carrying `total`, `totalPages` and `hasMore`.',
  })
  @ApiPaginatedEnvelope('events')
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      'Insufficient permissions, or an actor kind with no user of its own (plugin, system, external) ' +
      '— provisional: see #395',
  })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Event))
  @Get('browse')
  browseEvents(@Query() query: DefaultPaginationQueryDto) {
    return from(this.eventService.browseEvents(query)).pipe(
      map((page) => paginated('events', page, query, ResourceType.Event)),
    );
  }

  @ApiOperation({
    summary: 'Get event by ID',
    description:
      '`attendance` is `null` when the acting user doesn\u2019t attend or was removed, or when the actor doesn\u2019t ' +
      'have permission to read attendees.',
  })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Event retrieved successfully' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Event))
  @Get(':id')
  getEventById(@Param('id') id: string) {
    return from(this.eventService.getEventById(id)).pipe(map((event) => ({ event })));
  }

  @ApiOperation({ summary: 'Create an event' })
  @ApiResponse({ status: Http.Created, description: 'Event created successfully' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.Event))
  @Post()
  createEvent(@Body() createEventDto: CreateEventDto) {
    return from(this.eventService.createEvent(createEventDto)).pipe(
      map((event) => ({ message: t('success.event.created'), event })),
    );
  }

  @ApiOperation({ summary: 'Update an event' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Event updated successfully' })
  @ApiResponse({
    status: Http.BadRequest,
    description:
      'Invalid patch, or one carrying `policy`, `occurrences` or `inviteUserIds`, which change on routes of their ' +
      'own; or a switch to Fixed while more than one date is proposed or confirmed ' +
      '(code EVENT_FIXED_MODE_TOO_MANY_DATES)',
  })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Event))
  @Patch(':id')
  updateEvent(@Param('id') id: string, @Body() updateEventDto: UpdateEventDto) {
    return from(this.eventService.updateEvent(id, updateEventDto)).pipe(
      map((event) => ({
        message: t('success.event.updated', { id }),
        event,
      })),
    );
  }

  @ApiOperation({ summary: 'Soft-delete an event' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Event deleted successfully' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.Event))
  @Delete(':id')
  deleteEvent(@Param('id') id: string) {
    return from(this.eventService.deleteEvent(id)).pipe(
      tap((event) => this.logger.log(`Event ${id} deleted by user ${event.deletedById}`)),
      map((event) => ({
        message: t('success.event.deleted', { id }),
        event,
      })),
    );
  }
}
