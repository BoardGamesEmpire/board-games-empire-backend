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
      '**Breaking change (#512).** This route previously widened with the caller: a household member also received every event ' +
      'in their households, a friend received friends\u2019 `Friends`-visible events, and Owner/Admin/Moderator ' +
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
  getEvents(@Query() pagination: DefaultPaginationQueryDto) {
    return from(this.eventService.getEvents(pagination)).pipe(
      map((page) => paginated('events', page, pagination, ResourceType.Event)),
    );
  }

  @ApiOperation({ summary: 'Get event by ID' })
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
      tap((event) => this.logger.log(`Event "${event.title}" (${event.id}) created by user ${event.createdById}`)),
      map((event) => ({ message: t('success.event.created'), event })),
    );
  }

  @ApiOperation({ summary: 'Update an event' })
  @ApiParam({ name: 'id', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Event updated successfully' })
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
