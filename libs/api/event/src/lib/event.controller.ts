import { Action, ResourceType } from '@bge/database';
import { AppAbility, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { ClsService } from 'nestjs-cls';
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

  constructor(private readonly eventService: EventService, private readonly cls: ClsService) {}

  @ApiOperation({ summary: 'List events' })
  @ApiResponse({ status: Http.Ok, description: 'Events retrieved successfully' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Event))
  @Get()
  getEvents(@Query() pagination: PaginationQueryDto) {
    const abilities = this.getAbilities();
    return from(this.eventService.getEvents(pagination, abilities)).pipe(map((events) => ({ events })));
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
    const abilities = this.getAbilities();
    return from(this.eventService.getEventById(id, abilities)).pipe(map((event) => ({ event })));
  }

  @ApiOperation({ summary: 'Create an event' })
  @ApiResponse({ status: Http.Created, description: 'Event created successfully' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.Event))
  @Post()
  createEvent(@Session() session: UserSession, @Body() createEventDto: CreateEventDto) {
    return from(this.eventService.createEvent(session.user.id, createEventDto)).pipe(
      tap((event) => this.logger.log(`Event "${event.title}" (${event.id}) created by user ${session.user.id}`)),
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
    const abilities = this.getAbilities();
    return from(this.eventService.updateEvent(id, updateEventDto, abilities)).pipe(
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
  deleteEvent(@Param('id') id: string, @Session() session: UserSession) {
    const abilities = this.getAbilities();
    return from(this.eventService.deleteEvent(id, session.user.id, abilities)).pipe(
      tap(() => this.logger.log(`Event ${id} deleted by user ${session.user.id}`)),
      map((event) => ({
        message: `Event with ID ${id} deleted successfully`,
        event,
      })),
    );
  }

  private getAbilities() {
    const userAbility = this.cls.get<AppAbility>('userAbility');
    const apiAbility = this.cls.get<AppAbility>('apiKeyAbility');
    return [userAbility, apiAbility].filter(Boolean);
  }
}
