import { Action, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { CheckPolicies, PoliciesGuard } from '@bge/permissions';
import { ApiPaginatedEnvelope, paginated } from '@bge/shared';
import { Body, Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { Http } from '@status/codes';
import { from } from 'rxjs';
import { map } from 'rxjs/operators';
import { CreateEventInviteDto } from './dto/create-event-invite.dto';
import { ListEventInvitesQueryDto } from './dto/list-event-invites-query.dto';
import { EventInviteService } from './event-invite.service';

/**
 * An event's own invite routes (#742): inviting someone, the event's list of
 * invites, and revoking one. The invitee answers, and the inviter withdraws,
 * on the party routes under `/invites`, as for a household invite.
 */
@ApiBearerAuth()
@ApiSecurity('api_key')
@ApiTags('event-invites')
@UseGuards(PoliciesGuard)
@Controller('events/:eventId/invites')
export class EventInviteController {
  constructor(private readonly inviteService: EventInviteService) {}

  // The type-only check below passes any event's participant; the service
  // asks again about an invite to this event, under its lock.
  @ApiOperation({
    summary: 'Invite someone to the event',
    description:
      'Invites a user, by id, offering an event role: participant by default, or any role but host. The ' +
      'invitee is not an attendee, and holds no event role, until they accept at ' +
      '`POST /invites/:inviteId/accept`. The host, a co-host and an organizer invite; so does an owner or ' +
      "admin of the event's household. A participant invites while the event policy's `allowMemberInvites` " +
      'is on, and only as a participant. Offering any other role needs the grant that gives that role out ' +
      'directly. Who may be invited is decided by the server’s invitee policy, a block between the two, and ' +
      "the invitee's own preference. The invite expires after seven days. Each invite counts toward the " +
      "inviter's daily event invite quota.",
  })
  @ApiParam({ name: 'eventId', type: String })
  @ApiResponse({ status: Http.Created, description: 'Invite sent: `{ message, invite }`, the invite `Pending`.' })
  @ApiResponse({ status: Http.BadRequest, description: 'An invalid field, or an invite to yourself' })
  @ApiResponse({ status: Http.PaymentRequired, description: 'The daily event invite quota is used up' })
  @ApiResponse({
    status: Http.Forbidden,
    description:
      'No grant to invite to this event, or the offered role needs one you lack; code `MEMBER_INVITES_OFF` ' +
      "when the event's policy does not let participants invite; or the server's invitee policy, a block " +
      "between the two, or the invitee's preference refuses this invitee",
  })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found or deleted, or no user with that id' })
  @ApiResponse({
    status: Http.Conflict,
    description: 'The user already attends the event, or already has an outstanding invite to it',
  })
  @CheckPolicies((ability) => ability.can(Action.create, ResourceType.Invite))
  @Post()
  createInvite(@Param('eventId') eventId: string, @Body() dto: CreateEventInviteDto) {
    return from(this.inviteService.createInvite(eventId, dto)).pipe(
      map((invite) => ({ message: t('success.event.invite_sent'), invite })),
    );
  }

  @ApiOperation({
    summary: "List the event's invites (host, co-host, or the event household's owner or admin)",
    description:
      'Newest first. By default the invites still open and the ones that expired unanswered; `?status=` ' +
      'picks any one status, judged as it stands now, so an outstanding invite past its expiry is ' +
      '`Expired`. Every row carries the role offered, the inviter and `inviteeName`, never the message. ' +
      "The host and co-hosts list them, as do the owners and admins of the event's household. " +
      'Paginated: `?page=` (1-based) and `?limit=`, with a `pagination` envelope carrying `total`, ' +
      '`totalPages` and `hasMore`. See #230.',
  })
  @ApiParam({ name: 'eventId', type: String })
  @ApiPaginatedEnvelope('invites')
  @ApiResponse({ status: Http.Forbidden, description: "No grant to list this event's invites" })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found or deleted' })
  @CheckPolicies((ability) => ability.can(Action.read, ResourceType.Invite))
  @Get()
  listInvites(@Param('eventId') eventId: string, @Query() query: ListEventInvitesQueryDto) {
    return from(this.inviteService.listInvites(eventId, query)).pipe(
      map((page) => paginated('invites', page, query, ResourceType.Invite)),
    );
  }

  // The type-only check below passes the host of any event; the service asks
  // again about an invite to this one, under its lock.
  @ApiOperation({
    summary: "Revoke an invite someone else sent (host, co-host, or the event household's owner or admin)",
    description:
      'Cancels an open invite to the event that someone else sent, whether or not they still attend. An ' +
      'invite you sent yourself is refused here: withdraw it with `POST /invites/:inviteId/withdraw`, ' +
      "signed in. The host and co-hosts revoke, as do the owners and admins of the event's household. " +
      'The answer carries the invite without its message.',
  })
  @ApiParam({ name: 'eventId', type: String })
  @ApiParam({ name: 'inviteId', type: String })
  @ApiResponse({ status: Http.Ok, description: 'Revoked: `{ message, invite }`, the invite now `Revoked`.' })
  @ApiResponse({
    status: Http.Forbidden,
    description: "No grant to revoke this event's invites, or you sent this invite: withdraw it instead",
  })
  @ApiResponse({ status: Http.NotFound, description: 'Event not found or deleted, or no such invite to it' })
  @ApiResponse({
    status: Http.Conflict,
    description: 'The invite was already settled, has expired, or changed while it was being revoked',
  })
  @CheckPolicies((ability) => ability.can(Action.update, ResourceType.Invite))
  @HttpCode(Http.Ok)
  @Post(':inviteId/revoke')
  revokeInvite(@Param('eventId') eventId: string, @Param('inviteId') inviteId: string) {
    return from(this.inviteService.revokeInvite(eventId, inviteId)).pipe(
      map((invite) => ({ message: t('success.event.invite_revoked'), invite })),
    );
  }
}
