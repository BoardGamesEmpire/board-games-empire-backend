import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Session, type UserSession } from '@thallesp/nestjs-better-auth';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { EventService } from './event.service';

@ApiTags('events')
@UseGuards(PoliciesGuard)
@Controller('events')
export class EventController {
  constructor(private eventService: EventService) {}

  @Get()
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Event))
  getEvents() {
    return this.eventService.getEvents();
  }

  @Get(':id')
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Event))
  getEventById(@Param('id') id: string) {
    return this.eventService.getEventById(id);
  }

  @Post()
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.Event))
  createEvent(@Session() userSession: UserSession, @Body() createEventDto: CreateEventDto) {
    return this.eventService.createEvent(userSession.user.id, createEventDto);
  }

  @Patch(':id')
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Event))
  updateEvent(@Param('id') id: string, @Body() updateEventDto: UpdateEventDto) {
    return this.eventService.updateEvent(id, updateEventDto);
  }
}
