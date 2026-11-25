import { Action, DatabaseService, InviteStatus, InviteType, Prisma, ResourceType, SystemRole } from '@bge/database';
import { SHOWN_NAME_SELECT, shownName } from '@bge/household';
import { t } from '@bge/i18n';
import type { InviteContextView, InviteDomainEvent, InvitePartyView } from '@bge/invites';
import {
  CONTEXT_INVITE_SELECT,
  effectiveInviteStatusWhere,
  InviteService,
  OUTSTANDING_INVITE_STATUSES,
  withEffectiveInviteStatus,
} from '@bge/invites';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import type { QuotaSoftOverageEvent } from '@bge/quota';
import { QuotaExceededException, QuotaService } from '@bge/quota';
import type { PaginatedRows } from '@bge/shared';
import { BadRequestException, ConflictException, Injectable, InternalServerErrorException } from '@nestjs/common';
import type { AssignableAttendeeRole } from '../attendee/dto/add-attendee.dto';
import { assertInvitable } from '../attendee/invitable';
import { NOT_REMOVED } from '../constants/not-removed.constant';
import { assertEventExists } from '../event-access.helpers';
import { lockLiveEvent, shareLiveEvent } from '../utils/lock-live-event.util';
import { CreateEventInviteDto } from './dto/create-event-invite.dto';
import { ListEventInvitesQueryDto } from './dto/list-event-invites-query.dto';
import { assertMayInvite, eventInviteSubject, readEventInviteAuthority } from './event-invite-authority';

/**
 * The column a revoke names, as the household revoke names it
 * (`HouseholdInviteService`): the revoke permissions are bound to it, so a
 * later permission on another invite column does not pass for a revoke (#742).
 */
const REVOKE_FIELD = Prisma.InviteScalarFieldEnum.status;

/**
 * The statuses the event's list shows by default (#742): the invites still
 * open, and the ones that ran out unanswered, which the host may want to send
 * again. Settled ones need `?status=`.
 */
const LISTED_BY_DEFAULT: readonly InviteStatus[] = [...OUTSTANDING_INVITE_STATUSES, InviteStatus.Expired];

/** One invite to the event, as the route and the event's create both send one (#742). */
export interface EventInviteInput {
  readonly eventId: string;
  readonly inviterId: string;
  readonly message?: string | null;
  readonly role: AssignableAttendeeRole;
  readonly userId: string;
}

/**
 * What {@link EventInviteService.inviteWithin} hands back: the invite as its
 * inviter sees it, and what the caller emits after its transaction commits,
 * in order: the domain events (any expired rivals the lib stamped, then the
 * created invite), then the soft caps the invite went past.
 */
export interface EventInviteCreation {
  readonly events: readonly InviteDomainEvent[];
  readonly invite: InvitePartyView;
  readonly softOverages: readonly QuotaSoftOverageEvent[];
}

/**
 * Sends, lists and revokes an event's invites (#742). The lifecycle itself is
 * `@bge/invites`'s; this is the event's side of it: who may invite, offering
 * which role, under the event policy's `allowMemberInvites`; whom they may
 * invite; and who sees and revokes which rows. Accepting is the party routes'.
 *
 * An invitee has no attendee row and no event role until they accept.
 */
@Injectable()
export class EventInviteService {
  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
    private readonly invites: InviteService,
    private readonly quotas: QuotaService,
  ) {}

  /**
   * Opens an invite to the event (#742), in one transaction:
   *
   * 1. The event row is share-locked. The event's delete updates it, which
   *    waits on the share, and then revokes every outstanding invite, so an
   *    invite inserted under the lock is never left open on a deleted event.
   *    An event that isn't live answers 404.
   * 2. The event's roster and policy are read under the lock, so a role
   *    change or removal that landed first is seen.
   * 3. The acting user's authority is asked before anything about the
   *    invitee, so a caller with no say over the event learns nothing about
   *    who exists or attends it ({@link assertMayInvite}).
   * 4. {@link inviteWithin}: whom they may invite, the daily cap, the insert.
   *
   * The domain events go out after commit, then any soft cap the invite went
   * past.
   */
  async createInvite(eventId: string, dto: CreateEventInviteDto): Promise<InvitePartyView> {
    const inviterId = this.abilityService.getActingUserId();
    const role = dto.role ?? SystemRole.EventParticipant;

    const { invite, events, softOverages } = await this.db.$transaction(async (tx) => {
      await shareLiveEvent(tx, eventId);
      const authority = await readEventInviteAuthority(tx, eventId);

      assertMayInvite(this.abilityService, authority, role);

      return this.inviteWithin(tx, { eventId, inviterId, userId: dto.userId, role, message: dto.message ?? null });
    });

    this.invites.emit(events);
    this.quotas.emitSoftOverages(softOverages);

    return invite;
  }

  /**
   * Writes one invite to the event on the caller's transaction (#742), the
   * caller holding the event's lock and having settled the inviter's
   * authority. Asks the acting user nothing: the event's create calls it for
   * each invitee under the create's own grant, where the creator's ability,
   * built before the event existed, has no rule for it. In order:
   *
   * 1. The inviter is refused as their own invitee.
   * 2. The invitee must be a person the inviter may invite
   *    (`assertInvitable`): 404 for an id that names no person, 403 when the
   *    server's policy, a block or the invitee's preference refuses.
   * 3. Someone already attending answers 409: accepting would offer them
   *    nothing. A removed attendee may be invited back; accepting revives
   *    their row.
   * 4. The invite takes one of the inviter's event invites for the day, under
   *    the cap's advisory lock: 402 past a hard cap.
   * 5. The lib inserts, naming the invitee as the event's list shows them. A
   *    second outstanding invite to the same person is the database's 409,
   *    through the lib.
   */
  async inviteWithin(tx: Prisma.TransactionClient, input: EventInviteInput): Promise<EventInviteCreation> {
    const { eventId, inviterId, userId, role } = input;

    if (userId === inviterId) {
      throw new BadRequestException(t('errors.invite.self_invite'));
    }

    await assertInvitable(tx, inviterId, [userId]);

    const attending = await tx.eventAttendee.findFirst({
      where: { eventId, userId, ...NOT_REMOVED },
      select: { id: true },
    });

    if (attending) {
      throw new ConflictException(t('errors.attendee.already_attendee'));
    }

    const softOverages = await this.takeDailyInvite(tx, inviterId);
    const invitee = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: SHOWN_NAME_SELECT });

    const { invite, event, expired } = await this.invites.createWithin(tx, {
      type: InviteType.Event,
      eventId,
      inviterId,
      inviteeId: userId,
      inviteeName: shownName(invitee),
      roleId: await this.roleIdOf(tx, role),
      message: input.message ?? null,
    });

    return { invite, events: [...expired, event], softOverages };
  }

  /**
   * One page of the event's invites, newest first (#742), for its host and
   * co-host and, through the household variant, its household's owners and
   * admins.
   *
   * The caller must hold `read` on this event's invites, asked of the
   * instance: the route's type-only check passes the host of ANY event, and
   * without this they would get an empty page here rather than a 403. Asked
   * before the event's liveness, so only a caller who may read the invites
   * learns that the event is gone. The rows then compose under the same
   * grant.
   *
   * By default the open invites and the expired ones; `?status=` picks one
   * status as it stands now. Every row is in the context shape: the address
   * and the message stay with the invite's parties, and an inviter finds their
   * own at `GET /invites/sent`.
   */
  async listInvites(eventId: string, query: ListEventInvitesQueryDto): Promise<PaginatedRows<InviteContextView>> {
    const authority = await readEventInviteAuthority(this.db, eventId);
    this.abilityService.assertCurrentActorCan(Action.read, ResourceType.Invite, eventInviteSubject(authority));
    await assertEventExists(this.db, eventId);

    const now = new Date();
    const statusWhere =
      query.status === undefined
        ? { status: { in: [...LISTED_BY_DEFAULT] } }
        : effectiveInviteStatusWhere(query.status, now);
    const where = this.scopeComposer.compose(ResourceType.Invite, Action.read, { eventId, AND: [statusWhere] });

    // REPEATABLE READ, so `total` and the rows come from one snapshot (#230).
    // `id` breaks ties on `createdAt`, so a row cannot cross a page boundary
    // between two requests.
    const [rows, total] = await this.db.$transaction(
      [
        this.db.invite.findMany({
          where,
          select: CONTEXT_INVITE_SELECT,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: query.skip,
          take: query.pageSize,
        }),

        this.db.invite.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows: rows.map((row) => withEffectiveInviteStatus(row, now)), total };
  }

  /**
   * Cancels an invite someone else sent to the event (#742), in one
   * transaction:
   *
   * 1. The event row is locked as the event's other writes lock it, so no
   *    role change or removal lands between the answer below and the revoke,
   *    and the event's delete, which revokes every outstanding invite, takes
   *    its turn with this one. An event that isn't live answers 404.
   * 2. The caller must hold `update` on this invite's `status`, asked of the
   *    instance read under the lock: the route's type-only check passes the
   *    host of any event. The instance carries the invite's id, so a key
   *    scoped to one invite is asked about that one.
   * 3. The lib revokes, bound to this event: 404 for an id from another
   *    context, 403 for the invite's own inviter, who withdraws it instead, 409
   *    once expired or settled.
   *
   * The revoked invite is announced after commit. The row stays, so it still
   * counts against its inviter's day.
   */
  async revokeInvite(eventId: string, inviteId: string): Promise<InviteContextView> {
    const revokerId = this.abilityService.getActingUserId();

    const { invite, event } = await this.db.$transaction(async (tx) => {
      await lockLiveEvent(tx, eventId);
      const authority = await readEventInviteAuthority(tx, eventId);

      this.abilityService.assertCurrentActorCan(
        Action.update,
        ResourceType.Invite,
        { id: inviteId, ...eventInviteSubject(authority) },
        REVOKE_FIELD,
      );

      return this.invites.revokeWithin(tx, { inviteId, revokerId, scope: { eventId } });
    });

    this.invites.emit([event]);

    return invite;
  }

  /**
   * Takes one invite from the inviter's day of event invites (#742), on the
   * caller's transaction and under the cap's advisory lock, so the insert that
   * follows cannot overshoot a hard cap: 402 past one. Hands back the soft
   * caps it went past, for the caller to warn of after commit.
   */
  private async takeDailyInvite(
    tx: Prisma.TransactionClient,
    inviterId: string,
  ): Promise<readonly QuotaSoftOverageEvent[]> {
    const decision = await this.quotas.consume('event_invite_daily_count', 1n, { userId: inviterId }, tx);

    if (!decision.allowed) {
      throw new QuotaExceededException(
        // eslint-disable-next-line no-restricted-syntax -- quota metric key, not user copy; QuotaExceededException localizes its message in @bge/quota
        'event_invite_daily_count',
        decision.scope!,
        decision.limit!,
        decision.currentUsage!,
        1n,
      );
    }

    return decision.softOverages;
  }

  /** The id of the event role an invite offers. A role the server lacks is a provisioning fault, not the caller's. */
  private async roleIdOf(tx: Prisma.TransactionClient, role: AssignableAttendeeRole): Promise<string> {
    const row = await tx.role.findUnique({ where: { name: role }, select: { id: true } });

    if (!row) {
      throw new InternalServerErrorException(t('errors.event.role_not_provisioned', { role }));
    }

    return row.id;
  }
}
