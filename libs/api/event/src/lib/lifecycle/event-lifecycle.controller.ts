import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { Body, Controller, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { CancelEventDto } from './dto/cancel-event.dto';
import { EventLifecycleService } from './event-lifecycle.service';

/**
 * An event's host decisions, one route per transition (#795). Each check
 * names the column its transition writes, which the edit grants leave out of
 * their fields: an organizer or moderator who can `PATCH` the event is
 * refused here.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('events')
@UseGuards(PoliciesGuard)
@ApiParam({ name: 'id', type: String })
@Controller('events')
export class EventLifecycleController {
  constructor(private readonly lifecycle: EventLifecycleService) {}

  @ApiOperation({
    summary: 'Cancel an event',
    description:
      'Calls the event off with an optional reason. Its confirmed dates are cancelled with it and its proposed ' +
      'dates declined, and every attendee is told. A repeat answers with the event as it is, keeping the first ' +
      'reason. For its host and co-host, and the owners and admins of its household.',
  })
  @ApiResponse({ status: Http.Ok, description: 'Event cancelled, or already cancelled' })
  @ApiResponse({ status: Http.BadRequest, description: 'The event is archived; unarchive it first' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Event, 'cancelledAt'))
  @HttpCode(Http.Ok)
  @Post(':id/cancel')
  cancel(@Param('id') id: string, @Body() dto: CancelEventDto) {
    return from(this.lifecycle.cancelEvent(id, dto)).pipe(
      map((event) => ({ message: t('success.event.cancelled'), event })),
    );
  }

  @ApiOperation({
    summary: 'Archive an event',
    description:
      'Puts a cancelled event, or one whose dates have all passed, away. It is left out of `GET /events` ' +
      'unless `?includeArchived=true`, and stays readable by id. A live event is cancelled first. ' +
      'Nobody is told. For its host and co-host.',
  })
  @ApiResponse({ status: Http.Ok, description: 'Event archived, or already archived' })
  @ApiResponse({ status: Http.BadRequest, description: 'The event is neither cancelled nor finished' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Event, 'archivedAt'))
  @HttpCode(Http.Ok)
  @Post(':id/archive')
  archive(@Param('id') id: string) {
    return from(this.lifecycle.archiveEvent(id)).pipe(
      map((event) => ({ message: t('success.event.archived'), event })),
    );
  }

  @ApiOperation({
    summary: 'Unarchive an event',
    description: 'Takes an archived event out again, still cancelled if it was. Nobody is told.',
  })
  @ApiResponse({ status: Http.Ok, description: 'Event unarchived, or not archived' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Event, 'archivedAt'))
  @HttpCode(Http.Ok)
  @Post(':id/unarchive')
  unarchive(@Param('id') id: string) {
    return from(this.lifecycle.unarchiveEvent(id)).pipe(
      map((event) => ({ message: t('success.event.unarchived'), event })),
    );
  }

  @ApiOperation({
    summary: 'Reopen a cancelled event',
    description:
      'Clears the cancel, and every attendee is told. The dates stay as the cancel left them. ' +
      'A repeat answers with the event as it is.',
  })
  @ApiResponse({ status: Http.Ok, description: 'Event reopened, or not cancelled' })
  @ApiResponse({ status: Http.BadRequest, description: 'The event is cancelled and archived; unarchive it first' })
  @ApiResponse({ status: Http.Unauthorized, description: 'Authentication required' })
  @ApiResponse({ status: Http.Forbidden, description: 'Insufficient permissions' })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found' })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Event, 'cancelledAt'))
  @HttpCode(Http.Ok)
  @Post(':id/reopen')
  reopen(@Param('id') id: string) {
    return from(this.lifecycle.reopenEvent(id)).pipe(map((event) => ({ message: t('success.event.reopened'), event })));
  }
}
