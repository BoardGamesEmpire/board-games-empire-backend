import { Action, ResourceType } from '@bge/database';
import { AppAbility, CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { Session } from '@thallesp/nestjs-better-auth';
import { ClsService } from 'nestjs-cls';
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

  constructor(
    private readonly attendeeService: EventAttendeeService,
    private readonly cls: ClsService,
  ) {}

  @ApiOperation({ summary: 'List attendees for an event' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Attendees retrieved' })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.EventAttendee))
  @Get()
  getAttendees(@Param('eventId') eventId: string) {
    const abilities = this.getAbilities();
    return from(this.attendeeService.getAttendees(eventId, abilities)).pipe(map((attendees) => ({ attendees })));
  }

  @ApiOperation({ summary: 'Get a single attendee' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'attendeeId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Attendee retrieved' })
  @ApiResponse({ status: Http.NotFound, description: 'Attendee or event not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.EventAttendee))
  @Get(':attendeeId')
  getAttendee(@Param('eventId') eventId: string, @Param('attendeeId') attendeeId: string) {
    const abilities = this.getAbilities();
    return from(this.attendeeService.getAttendee(eventId, attendeeId, abilities)).pipe(map((attendee) => ({ attendee })));
  }

  @ApiOperation({ summary: 'Add an attendee to an event' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiResponse({ status: Http.Created, description: 'Attendee added' })
  @ApiResponse({ status: Http.Conflict, description: 'User is already an attendee' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.EventAttendee))
  @Post()
  addAttendee(@Param('eventId') eventId: string, @Session() session: UserSession, @Body() dto: AddAttendeeDto) {
    return from(this.attendeeService.addAttendee(eventId, dto, session.user.id)).pipe(
      tap((attendee) => this.logger.log(`Attendee ${attendee.id} added to event ${eventId} by ${session.user.id}`)),
      map((attendee) => ({ message: 'Attendee added successfully', attendee })),
    );
  }

  @ApiOperation({ summary: 'Remove an attendee from an event' })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'attendeeId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Attendee removed' })
  @ApiResponse({ status: Http.NotFound, description: 'Attendee not found' })
  @CheckPolicies((ability) => ability.can(Action.manage, ResourceType.EventAttendee))
  @Delete(':attendeeId')
  removeAttendee(
    @Param('eventId') eventId: string,
    @Param('attendeeId') attendeeId: string,
    @Session() session: UserSession,
  ) {
    const abilities = this.getAbilities();
    return from(this.attendeeService.removeAttendee(eventId, attendeeId, session.user.id, abilities)).pipe(
      tap(() => this.logger.log(`Attendee ${attendeeId} removed from event ${eventId} by ${session.user.id}`)),
      map((attendee) => ({
        message: 'Attendee removed successfully',
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
    const abilities = this.getAbilities();
    return from(this.attendeeService.updateStatus(eventId, attendeeId, dto, abilities)).pipe(
      map((attendee) => ({
        message: 'Attendee status updated',
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
    const abilities = this.getAbilities();
    return from(this.attendeeService.getGameList(eventId, attendeeId, abilities)).pipe(map((games) => ({ games })));
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
      map((entry) => ({ message: 'Game added to list', entry })),
    );
  }

  @ApiOperation({ summary: "Remove a game from an attendee's available list" })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'attendeeId', type: String })
  @ApiParam({ name: 'gameListId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Game removed from list' })
  @ApiResponse({ status: Http.NotFound, description: 'Game list entry not found' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.EventAttendeeGameList))
  @Delete(':attendeeId/games/:gameListId')
  removeGameFromList(
    @Param('eventId') eventId: string,
    @Param('attendeeId') attendeeId: string,
    @Param('gameListId') gameListId: string,
  ) {
    const abilities = this.getAbilities();
    return from(this.attendeeService.removeGameFromList(eventId, attendeeId, gameListId, abilities)).pipe(
      map((entry) => ({ message: 'Game removed from list', entry })),
    );
  }

  private getAbilities(): AppAbility[] {
    const userAbility = this.cls.get<AppAbility>('userAbility');
    const apiAbility = this.cls.get<AppAbility>('apiKeyAbility');
    return [userAbility, apiAbility].filter(Boolean) as AppAbility[];
  }
}
