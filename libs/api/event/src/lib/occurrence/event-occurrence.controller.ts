import { Action, ResourceType } from '@bge/database';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, Delete, Get, Logger, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import { AddOccurrenceDto } from './dto/add-occurrence.dto';
import { SubmitAvailabilityDto } from './dto/submit-availability.dto';
import { UpdateEventOccurrenceDto } from './dto/update-event-occurrence.dto';
import { EventOccurrenceService } from './event-occurrence.service';

@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('event-occurrences')
@UseGuards(PoliciesGuard)
@ApiParam({ name: 'eventId', type: String })
@Controller('events/:eventId/occurrences')
export class EventOccurrenceController {
  private readonly logger = new Logger(EventOccurrenceController.name);

  constructor(private readonly occurrenceService: EventOccurrenceService) {}

  @ApiOperation({ summary: 'List occurrences for an event' })
  @ApiResponse({ status: Http.Ok, description: 'Occurrences retrieved' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.EventOccurrence))
  @Get()
  getOccurrences(@Param('eventId') eventId: string) {
    return from(this.occurrenceService.getOccurrences(eventId)).pipe(map((occurrences) => ({ occurrences })));
  }

  @ApiOperation({ summary: 'Get a single occurrence' })
  @ApiParam({ name: 'occurrenceId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Occurrence retrieved' })
  @ApiResponse({ status: Http.NotFound, description: 'Occurrence not found' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.EventOccurrence))
  @Get(':occurrenceId')
  getOccurrence(@Param('eventId') eventId: string, @Param('occurrenceId') occurrenceId: string) {
    return from(this.occurrenceService.getOccurrence(eventId, occurrenceId)).pipe(
      map((occurrence) => ({ occurrence })),
    );
  }

  @ApiOperation({ summary: 'Add an occurrence to the event' })
  @ApiResponse({ status: Http.Created, description: 'Occurrence added' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.EventOccurrence))
  @Post()
  addOccurrence(@Param('eventId') eventId: string, @Body() dto: AddOccurrenceDto) {
    return from(this.occurrenceService.addOccurrence(eventId, dto)).pipe(
      tap((occ) => this.logger.log(`Occurrence ${occ.id} added to event ${eventId}`)),
      map((occurrence) => ({ message: 'Occurrence added', occurrence })),
    );
  }

  @ApiOperation({ summary: 'Update an occurrence' })
  @ApiParam({ name: 'occurrenceId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Occurrence updated' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.EventOccurrence))
  @Patch(':occurrenceId')
  updateOccurrence(
    @Param('eventId') eventId: string,
    @Param('occurrenceId') occurrenceId: string,
    @Body() dto: UpdateEventOccurrenceDto,
  ) {
    return from(this.occurrenceService.updateOccurrence(eventId, occurrenceId, dto)).pipe(
      map((occurrence) => ({ message: 'Occurrence updated', occurrence })),
    );
  }

  @ApiOperation({ summary: 'Remove an occurrence from the event' })
  @ApiParam({ name: 'occurrenceId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Occurrence removed' })
  @CheckPolicies((ability) => ability.can(Action.delete, ResourceType.EventOccurrence))
  @Delete(':occurrenceId')
  removeOccurrence(@Param('eventId') eventId: string, @Param('occurrenceId') occurrenceId: string) {
    return from(this.occurrenceService.removeOccurrence(eventId, occurrenceId)).pipe(
      tap(() => this.logger.log(`Occurrence ${occurrenceId} removed from event ${eventId}`)),
      map((occurrence) => ({ message: 'Occurrence removed', occurrence })),
    );
  }

  @ApiOperation({ summary: 'Confirm a proposed occurrence (Poll mode → Confirmed)' })
  @ApiParam({ name: 'occurrenceId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Occurrence confirmed' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.EventOccurrence))
  @Post(':occurrenceId/confirm')
  confirm(@Param('eventId') eventId: string, @Param('occurrenceId') occurrenceId: string) {
    return from(this.occurrenceService.confirmOccurrence(eventId, occurrenceId)).pipe(
      map((occurrence) => ({ message: 'Occurrence confirmed', occurrence })),
    );
  }

  @ApiOperation({ summary: 'Decline a proposed occurrence (Poll mode → Declined)' })
  @ApiParam({ name: 'occurrenceId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Occurrence declined' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.EventOccurrence))
  @Post(':occurrenceId/decline')
  decline(@Param('eventId') eventId: string, @Param('occurrenceId') occurrenceId: string) {
    return from(this.occurrenceService.declineOccurrence(eventId, occurrenceId)).pipe(
      map((occurrence) => ({ message: 'Occurrence declined', occurrence })),
    );
  }

  @ApiOperation({ summary: 'Cancel a confirmed occurrence' })
  @ApiParam({ name: 'occurrenceId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Occurrence cancelled' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.EventOccurrence))
  @Post(':occurrenceId/cancel')
  cancel(@Param('eventId') eventId: string, @Param('occurrenceId') occurrenceId: string) {
    return from(this.occurrenceService.cancelOccurrence(eventId, occurrenceId)).pipe(
      map((occurrence) => ({ message: 'Occurrence cancelled', occurrence })),
    );
  }

  @ApiOperation({ summary: 'Submit or update your availability for a proposed occurrence' })
  @ApiParam({ name: 'occurrenceId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Availability recorded' })
  @ApiResponse({ status: Http.BadRequest, description: 'Occurrence is not in Proposed status' })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.EventAvailabilityVote))
  @Post(':occurrenceId/availability')
  submitAvailability(
    @Param('eventId') eventId: string,
    @Param('occurrenceId') occurrenceId: string,
    @Body() dto: SubmitAvailabilityDto,
  ) {
    return from(this.occurrenceService.submitAvailability(eventId, occurrenceId, dto)).pipe(
      tap((vote) =>
        this.logger.log(
          `User ${vote.attendeeId} submitted availability for occurrence ${occurrenceId} in event ${eventId}: ${dto.response}`,
        ),
      ),
      map((vote) => ({ message: 'Availability recorded', vote })),
    );
  }

  @ApiOperation({ summary: 'Get aggregated availability summary for all occurrences' })
  @ApiResponse({ status: Http.Ok, description: 'Availability summary retrieved' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.EventAvailabilityVote))
  @Get('summary/availability')
  getAvailabilitySummary(@Param('eventId') eventId: string) {
    return from(this.occurrenceService.getAvailabilitySummary(eventId)).pipe(map((summary) => ({ summary })));
  }
}
