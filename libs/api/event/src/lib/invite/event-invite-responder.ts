import { DatabaseService, EventParticipationStatus, InviteStatus, InviteType } from '@bge/database';
import { t } from '@bge/i18n';
import type { InvitePartyView, InviteResponder, InviteTarget, RespondToInviteParams } from '@bge/invites';
import { inviteNotOutstanding, InviteService } from '@bge/invites';
import { LineupRemovalReason } from '@bge/notifications-service';
import { AbilityService, PermissionsService } from '@bge/permissions';
import { ConflictException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { attendeeAddedEvent, emitSuppliedGameChanges, seatUserWithin } from '../attendee/attendance';
import type { AttendeeWithGames } from '../attendee/event-attendee.service';
import { AttendeeAddedEvent } from '../attendee/events/attendee.events';
import { NOT_REMOVED } from '../constants/not-removed.constant';
import { OfferedGameService } from '../offered-game/offered-game.service';
import { shareLiveEvent } from '../utils/lock-live-event.util';
import { offeredAttendeeRole, readEventInviteAuthority, senderCouldStillSend } from './event-invite-authority';

/** An accepted event invite, and the attendee row it seated. */
export interface EventInviteAcceptance {
  readonly attendee: AttendeeWithGames;
  readonly invite: InvitePartyView;
}

/**
 * How an invitee names an event invite of theirs to the lib: the target, and
 * the type. No address is vouched: an event invite names its invitee by id
 * (#742), and one sent to an address is #488's.
 */
function inviteeLookup(target: InviteTarget, inviteeId: string): RespondToInviteParams {
  return { target, actingUserId: inviteeId, type: InviteType.Event };
}

/** Someone already on the event joins nothing by accepting; the rollback leaves the invite outstanding. */
function alreadyAttending(): ConflictException {
  return new ConflictException(t('errors.attendee.already_attendee'));
}

/**
 * A party's answers to an event invite: accepting or declining one they
 * received, and withdrawing one they sent (#742). The party routes hand an
 * event invite here once they know its type. The event's side, sending,
 * listing and revoking an event's invites, is `EventInviteService`.
 *
 * An invitee has no attendee row and no event role until they accept, so
 * accepting is what seats them, attending.
 *
 * No CASL rule of the acting user's stands behind any of them: a party holds
 * no grant on `Invite`, and needs none, because `@bge/invites` binds every
 * party read to the acting user in the query (#161). That is why an inviter
 * withdraws whatever their standing on the event is now. The accept does ask
 * one question of a grant, of the invite's sender rather than the acting
 * user: whether they could still send it. The party route resolves who the
 * acting user may be and passes them in (`PartyInviteService`, #276).
 */
@Injectable()
export class EventInviteResponder implements InviteResponder<EventInviteAcceptance> {
  readonly type = InviteType.Event;

  constructor(
    private readonly db: DatabaseService,
    private readonly invites: InviteService,
    private readonly abilities: AbilityService,
    private readonly permissions: PermissionsService,
    private readonly eventEmitter: EventEmitter2,
    private readonly offeredGames: OfferedGameService,
  ) {}

  /**
   * The acting user accepts an event invite and is seated on the event, in
   * one transaction:
   *
   * 1. The invite's event is read, bound to the acting user as invitee, so a
   *    stranger meets a 404 that names no event.
   * 2. The event row is share-locked. The event's delete updates it before
   *    it revokes the event's invites; accepting first and locking second
   *    would take the two in the other order, and Postgres would abort one.
   *    An event that isn't live answers 404, as the household accept answers
   *    for a deleted household, and the invite stays as the delete left it.
   * 3. The lib reads the invite as it would accept it: 403 for the inviter,
   *    409 once expired or settled.
   * 4. Its sender must still be able to send it, offering that role, asked of
   *    the event's roster and policy as read under the lock
   *    ({@link senderCouldStillSend}). If not, it is revoked instead, and the
   *    answer is the 409 a revoked invite gets. Unless the acting user is
   *    already on the event: then the answer is step 5's, and nothing is
   *    revoked, for step 5's reason.
   * 5. Someone already on the event joins nothing, so the answer is 409 and
   *    the rollback leaves the invite outstanding. Settling it would say
   *    nothing true.
   * 6. The lib accepts.
   * 7. The invitee is seated attending, in the role the invite offers, as
   *    invited by the inviter's own attendee row, or by nobody when the
   *    inviter attends nothing (`seatUserWithin`). Someone a host removed
   *    earlier has their row revived rather than a second inserted (#551),
   *    and the nominations paused when they left resume. A concurrent write
   *    that seated them first answers 409, as step 5 does.
   *
   * After commit the invitee's ability cache is evicted, so their event role
   * holds from their next request, and then the accepted invite and the new
   * attendee are announced. An invite revoked at step 4 is committed and
   * announced before the 409 goes out.
   *
   * The attendee is answered with the games they offer, read after commit
   * under the acting user's ability as this request began it: one revived
   * from a removal shows their games from their next request.
   *
   * By token, the token is the credential: whoever holds the link reaches the
   * invite (#161), as long as it names them.
   */
  async accept(target: InviteTarget, inviteeId: string): Promise<EventInviteAcceptance> {
    const initiatedAt = new Date();
    const lookup = inviteeLookup(target, inviteeId);

    const outcome = await this.db.$transaction(async (tx) => {
      const { eventId } = await this.invites.findPartyScopeWithin(tx, lookup, InviteType.Event);
      await shareLiveEvent(tx, eventId);

      const offer = await this.invites.findAcceptableWithin(tx, lookup);
      const authority = await readEventInviteAuthority(tx, eventId);
      const role = offeredAttendeeRole(offer);
      const attending = authority.attendees.some((attendee) => attendee.userId === inviteeId);

      if (!(await senderCouldStillSend(this.abilities, tx, authority, { inviterId: offer.inviterId, role }))) {
        if (attending) {
          throw alreadyAttending();
        }

        const { event } = await this.invites.revokeWithin(tx, {
          inviteId: offer.id,
          revokerId: inviteeId,
          scope: { eventId },
        });

        return { accepted: false as const, revoked: event };
      }

      if (attending) {
        throw alreadyAttending();
      }

      const accepted = await this.invites.acceptWithin(tx, lookup);
      const inviter = await tx.eventAttendee.findUnique({
        where: { eventId_userId: { eventId, userId: offer.inviterId }, ...NOT_REMOVED },
        select: { id: true },
      });

      const seat = await seatUserWithin(tx, {
        eventId,
        userId: inviteeId,
        roleName: role,
        status: EventParticipationStatus.Attending,
        invitedByAttendeeId: inviter?.id ?? null,
        at: initiatedAt,
      });

      return { accepted: true as const, eventId, ...accepted, ...seat };
    });

    if (!outcome.accepted) {
      this.invites.emit([outcome.revoked]);

      // The answer a revoked invite gets, so the invitee learns nothing of why.
      throw inviteNotOutstanding(InviteStatus.Revoked);
    }

    const { eventId, invite, event, attendee, changes, revived } = outcome;

    await this.permissions.invalidateUser(inviteeId);
    this.invites.emit([event]);
    this.eventEmitter.emit(AttendeeAddedEvent.eventName, attendeeAddedEvent(revived, attendee, initiatedAt));

    if (changes) {
      emitSuppliedGameChanges(
        this.eventEmitter,
        eventId,
        changes,
        LineupRemovalReason.SupplierLeft,
        inviteeId,
        initiatedAt,
      );
    }

    const games = await this.offeredGames.forAttendees([attendee.id], initiatedAt);

    return { invite, attendee: { ...attendee, availableGames: games.get(attendee.id) ?? [] } };
  }

  /**
   * The acting user declines an event invite they received, by id or by the
   * token from its link (#742).
   *
   * The lib's read is bound to an event invite, so an invite of another type
   * is the 404 a stranger meets. Only the invite row moves, so no event lock
   * is taken; a delete that revoked the invite first leaves the decline its
   * 409. The lib answers the rest: 403 for the inviter, 409 once expired or
   * settled. After commit the declined invite is announced.
   */
  async decline(target: InviteTarget, inviteeId: string): Promise<InvitePartyView> {
    const { invite, event } = await this.db.$transaction((tx) =>
      this.invites.declineWithin(tx, inviteeLookup(target, inviteeId)),
    );

    this.invites.emit([event]);

    return invite;
  }

  /**
   * The acting user takes back an event invite they sent (#742). It is theirs
   * whatever their standing on the event now, so nothing about the event is
   * asked: a household owner who attends nothing withdraws as the host does.
   * One removed from the event has nothing left to withdraw, since the
   * removal revoked it, and meets the 409 a settled invite gets. Revoking
   * someone else's invite is `EventInviteService.revokeInvite`, and never
   * stands in for this.
   *
   * Bound to an event invite as {@link decline} is, and for the same reason
   * no lock is taken. The lib answers 404 to anyone who is not a party, 403
   * to the invitee, 409 once expired or settled. After commit the withdrawn
   * invite is announced.
   */
  async withdraw(inviteId: string, inviterId: string): Promise<InvitePartyView> {
    const { invite, event } = await this.db.$transaction((tx) =>
      this.invites.withdrawWithin(tx, { inviteId, actingUserId: inviterId, type: InviteType.Event }),
    );

    this.invites.emit([event]);

    return invite;
  }
}
