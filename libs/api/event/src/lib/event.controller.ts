import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { DefaultPaginationQueryDto } from '@bge/shared';
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

  @ApiOperation({ summary: 'List events' })
  @ApiResponse({ status: Http.Ok, description: 'Events retrieved successfully' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Event))
  @Get()
  getEvents(@Query() pagination: DefaultPaginationQueryDto) {
    return from(this.eventService.getEvents(pagination)).pipe(map((events) => ({ events })));
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
      map((event) => ({ message: 'Event created successfully', event })),
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
        message: `Event with ID ${id} updated successfully`,
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
        message: `Event with ID ${id} deleted successfully`,
        event,
      })),
    );
  }
}
