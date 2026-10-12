import {
  constraintIdentity,
  DatabaseService,
  identifiesConstraint,
  InviteStatus,
  InviteType,
  isIdentifiedConstraint,
  isPrismaUniqueConstraintError,
  Prisma,
} from '@bge/database';
import { t } from '@bge/i18n';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomBytes } from 'node:crypto';
import {
  DEFAULT_INVITE_TTL_MS,
  INVITE_TOKEN_BYTES,
  INVITE_TOKEN_MINT_ATTEMPTS,
  INVITE_TOKEN_UNIQUE_COLUMNS,
  OUTSTANDING_INVITE_STATUSES,
  OUTSTANDING_INVITE_UNIQUE_COLUMNS,
  OUTSTANDING_INVITE_UNIQUE_FIELDS,
  OUTSTANDING_INVITE_UNIQUE_INDEXES,
} from './constants/invite.constants';
import {
  InviteAcceptedEvent,
  InviteApprovedEvent,
  InviteCreatedEvent,
  InviteDeclinedEvent,
  InviteExpiredEvent,
  InviteRevokedEvent,
  InviteWithdrawnEvent,
  toInviteSnapshot,
  type InviteDomainEvent,
  type InviteTransitionEvent,
  type InviteTransitionEventClass,
} from './events/invite.events';
import type {
  ApproveInviteParams,
  CreateInviteParams,
  InviteAcceptance,
  InviteApproval,
  InviteCreation,
  InviteDeclination,
  InviteOutcome,
  InvitePartyLookup,
  InviteRevocation,
  InviteTarget,
  InviteWithdrawal,
  OutstandingInviteRevocation,
  RespondToInviteParams,
  RevokeInviteParams,
  RevokeOutstandingScope,
  WithdrawInviteParams,
} from './interfaces';
import { isOutstandingInviteStatus, withEffectiveInviteStatus } from './invite-expiry';
import {
  CONTEXT_INVITE_SELECT,
  INVITE_SNAPSHOT_SELECT,
  PARTY_INVITE_SELECT,
  TRANSITION_SELECT,
  type InvitePartyView,
  type InviteTransitionRow,
} from './read-shapes';

/**
 * A client for a read that takes no lock. The party read runs on the lib's own
 * client; a transition's read runs on the caller's transaction so the guarded
 * update that follows sees the same row. Either is correct for the lookup
 * itself, which is why both are admitted here and nowhere else.
 */
type ReadClient = DatabaseService | Prisma.TransactionClient;

/**
 * Trims and lower-cases an address, and treats an empty one as absent. The
 * partial unique index on `(household_id, invitee_email)` compares the column
 * as stored, so this is what makes `Sam@Example.test` and `sam@example.test`
 * the same outstanding invite.
 */
function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();

  return normalized ? normalized : null;
}

/**
 * Narrows a transition row to one of the client shapes, key by key.
 *
 * Every key of both shapes is on `TRANSITION_SELECT` (`read-shapes.spec.ts`
 * pins the subset), so this never reads a missing key; the cast says only that
 * the result has the shape's type, which the key-by-key copy guarantees. A
 * spread of the row would hand the caller the snapshot scalars as well, and
 * the context shape exists precisely to withhold some of those.
 */
function project<Select extends Prisma.InviteSelect>(
  row: InviteTransitionRow,
  select: Select,
): Prisma.InviteGetPayload<{ select: Select }> {
  const source = row as Record<string, unknown>;
  const view: Record<string, unknown> = {};

  for (const key of Object.keys(select)) {
    view[key] = source[key];
  }

  return view as Prisma.InviteGetPayload<{ select: Select }>;
}

/**
 * One status transition, as each of the five public transitions describes
 * itself to {@link InviteService.transitionWithin}.
 */
interface TransitionSpec<Select extends Prisma.InviteSelect, Event extends InviteTransitionEvent> {
  readonly target: InviteTarget;
  /** The acting user when the transition is a party's. Scopes the read: a stranger gets a miss. */
  readonly partyOf?: string;
  /** The role the transition needs once the row is known to be the actor's. Throws 403. */
  readonly assertRole?: (row: InviteTransitionRow) => void;
  /** The statuses the transition may start from. Throws 409 otherwise; runs again on a guard miss. */
  readonly assertStatus: (row: InviteTransitionRow) => void;
  readonly data: (now: Date) => Prisma.InviteUncheckedUpdateManyInput;
  readonly view: Select;
  readonly event: InviteTransitionEventClass<Event>;
}

/**
 * The polymorphic invite lifecycle (#161), as primitives a context owner
 * drives inside its own transaction.
 *
 * ## The seam
 *
 * Every write is a `*Within(tx, …)` taking the caller's
 * `Prisma.TransactionClient`, the shape of `HouseholdMemberService.addMemberWithin`.
 * The consumer owns the transaction because it owns the post-commit duties
 * that go with it: admitting the member an accept implies, invalidating
 * ability caches, emitting its own domain events. Each primitive hands back
 * the row as the caller may show it and the domain event to announce; the
 * caller emits that event AFTER commit through {@link emit}, so a rollback
 * never announces a transition it undid.
 *
 * ## Who may do what
 *
 * A party's read or transition binds its `where` to the acting user as
 * inviter or invitee, so a stranger meets a miss rather than a refusal. An
 * email-only invite, which has no invitee id, is reached by the token its link
 * carries instead. Context authority is the consumer's to assert before
 * calling: an owner or admin revoking, an approver approving. The lib never
 * checks a household or event role, and needs no `read` grant on `Invite` to
 * do its work.
 *
 * ## How a transition is made safe
 *
 * The row is read, refused for the right reason if it cannot move, and then
 * updated with its CURRENT status in the `where`. A concurrent transition
 * between the read and the update leaves that guard unmatched; the row is
 * re-read and the miss reported as the transition it now refuses, never as an
 * overwrite of the rival's result. Reading first rather than updating first is
 * what lets every domain event carry the status the row actually left, which
 * a decline from either outstanding status cannot otherwise know.
 *
 * ## Expiry
 *
 * Reads compute it (`effectiveInviteStatus`); a transition that meets an
 * outstanding row past its date persists `Expired` and refuses. That stamp is
 * written on the lib's own connection rather than the caller's transaction,
 * because the refusal is thrown and rolls the caller's transaction back, and
 * the refusal never waits on it. A create stamps the expired rivals the new
 * row would otherwise collide with, inside the caller's transaction, ahead
 * of its insert. #165's sweep persists the rows nobody touched.
 */
@Injectable()
export class InviteService {
  private readonly logger = new Logger(InviteService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * An invite as one of its parties sees it, with its status as it stands
   * right now: an outstanding row past its date reads `Expired` whatever the
   * row still says, and nothing is written. The invitee reaches an email-only
   * invite by the token its link carries; a stranger, by either route, gets
   * 404 rather than confirmation that the invite exists.
   */
  async findForParty({ target, actingUserId }: InvitePartyLookup): Promise<InvitePartyView> {
    const row = await this.loadForParty(this.db, target, actingUserId);

    return withEffectiveInviteStatus(project(row, PARTY_INVITE_SELECT));
  }

  /**
   * Opens an invite. `Pending`, or `AwaitingApproval` when the context's join
   * policy wants an approver first (#166).
   *
   * A second outstanding invite to the same invitee for the same context is
   * refused by the database, not by a lookup here: the partial unique indexes
   * of `20261012000000_invite_outstanding_unique` raise P2002 and it is mapped
   * to 409. A settled invite sits outside those indexes, so a re-invite after
   * a decline or an expiry is a fresh row with a fresh token. An invite that
   * expired but was never stamped is still inside them, so the create stamps
   * such rivals `Expired` first, on the caller's transaction, and hands their
   * events back beside its own.
   */
  async createWithin(tx: Prisma.TransactionClient, params: CreateInviteParams): Promise<InviteCreation> {
    const initiatedAt = new Date();
    const inviteeId = params.inviteeId ?? null;
    const inviteeEmail = normalizeEmail(params.inviteeEmail);

    if (inviteeId === null && inviteeEmail === null) {
      throw new BadRequestException(t('errors.invite.invitee_required'));
    }

    if (inviteeId === params.inviterId) {
      throw new BadRequestException(t('errors.invite.self_invite'));
    }

    const context = this.contextOf(params);
    const expiresAt = params.expiresAt ?? new Date(initiatedAt.getTime() + DEFAULT_INVITE_TTL_MS);

    if (expiresAt <= initiatedAt) {
      throw new BadRequestException(t('errors.invite.expires_in_past'));
    }

    const expired = await this.expireRivalsWithin(tx, context, { inviteeId, inviteeEmail }, initiatedAt);
    const token = await this.mintTokenWithin(tx);

    try {
      const row = await tx.invite.create({
        data: {
          type: params.type,
          status: params.needsApproval ? InviteStatus.AwaitingApproval : InviteStatus.Pending,
          inviterId: params.inviterId,
          inviteeId,
          inviteeEmail,
          inviteeName: params.inviteeName ?? null,
          householdId: params.householdId ?? null,
          eventId: params.eventId ?? null,
          roleId: params.roleId ?? null,
          message: params.message ?? null,
          metadata: params.metadata,
          needsApproval: params.needsApproval ?? false,
          token,
          expiresAt,
        },
        select: TRANSITION_SELECT,
      });

      return {
        invite: project(row, PARTY_INVITE_SELECT),
        event: new InviteCreatedEvent(toInviteSnapshot(row), initiatedAt),
        expired,
      };
    } catch (error) {
      throw this.translateCreateFailure(error);
    }
  }

  /**
   * The invitee accepts. From `Pending` only: an `AwaitingApproval` invite is
   * not yet the invitee's to accept, and the refusal says so rather than
   * reporting it as settled.
   *
   * The caller admits the member in the same transaction (#163); nothing here
   * touches the roster.
   */
  acceptWithin(
    tx: Prisma.TransactionClient,
    { target, actingUserId }: RespondToInviteParams,
  ): Promise<InviteAcceptance> {
    return this.transitionWithin(tx, {
      target,
      partyOf: actingUserId,
      assertRole: (row) => this.assertInvitee(row, target, actingUserId),
      assertStatus: (row) => {
        if (row.status === InviteStatus.AwaitingApproval) {
          throw new ConflictException(t('errors.invite.awaiting_approval', { id: row.id }));
        }

        this.assertFrom(row, [InviteStatus.Pending]);
      },
      data: (now) => ({
        status: InviteStatus.Accepted,
        respondedAt: now,
        // Binds an email-only invite to the user who accepted it. A no-op on a
        // user-bound row, whose invitee the role check already matched.
        inviteeId: actingUserId,
      }),
      view: PARTY_INVITE_SELECT,
      event: InviteAcceptedEvent,
    });
  }

  /**
   * The invitee declines, from either outstanding status. A refusal is never
   * gated on someone else's approval.
   */
  declineWithin(
    tx: Prisma.TransactionClient,
    { target, actingUserId }: RespondToInviteParams,
  ): Promise<InviteDeclination> {
    return this.transitionWithin(tx, {
      target,
      partyOf: actingUserId,
      assertRole: (row) => this.assertInvitee(row, target, actingUserId),
      assertStatus: (row) => this.assertFrom(row, OUTSTANDING_INVITE_STATUSES),
      data: (now) => ({
        status: InviteStatus.Declined,
        respondedAt: now,
        // Records who declined an email-only invite, as accept records who took it.
        inviteeId: actingUserId,
      }),
      view: PARTY_INVITE_SELECT,
      event: InviteDeclinedEvent,
    });
  }

  /** The inviter takes the invite back, from either outstanding status. */
  withdrawWithin(
    tx: Prisma.TransactionClient,
    { inviteId, actingUserId }: WithdrawInviteParams,
  ): Promise<InviteWithdrawal> {
    return this.transitionWithin(tx, {
      target: { inviteId },
      partyOf: actingUserId,
      assertRole: (row) => this.assertInviter(row, actingUserId),
      assertStatus: (row) => this.assertFrom(row, OUTSTANDING_INVITE_STATUSES),
      data: (now) => ({ status: InviteStatus.Withdrawn, respondedAt: now }),
      view: PARTY_INVITE_SELECT,
      event: InviteWithdrawnEvent,
    });
  }

  /**
   * A context authority cancels the invite, from either outstanding status.
   * The caller has asserted that authority; nothing here binds to an actor.
   * Returns the context shape: a revoker is not a party and does not see the
   * address or the message.
   */
  revokeWithin(tx: Prisma.TransactionClient, { inviteId }: RevokeInviteParams): Promise<InviteRevocation> {
    return this.transitionWithin(tx, {
      target: { inviteId },
      assertStatus: (row) => this.assertFrom(row, OUTSTANDING_INVITE_STATUSES),
      data: (now) => ({ status: InviteStatus.Revoked, respondedAt: now }),
      view: CONTEXT_INVITE_SELECT,
      event: InviteRevokedEvent,
    });
  }

  /**
   * An approver opens an `AwaitingApproval` invite to its invitee, stamping
   * who approved and when (#166). The caller has asserted the approver's
   * authority.
   */
  approveWithin(tx: Prisma.TransactionClient, { inviteId, approverId }: ApproveInviteParams): Promise<InviteApproval> {
    return this.transitionWithin(tx, {
      target: { inviteId },
      assertStatus: (row) => {
        if (row.status !== InviteStatus.AwaitingApproval) {
          throw new ConflictException(t('errors.invite.not_awaiting_approval', { id: row.id }));
        }
      },
      data: (now) => ({ status: InviteStatus.Pending, approvedById: approverId, approvedAt: now }),
      view: CONTEXT_INVITE_SELECT,
      event: InviteApprovedEvent,
    });
  }

  /**
   * Closes every outstanding invite into a context, as a household's soft
   * delete does. Expired-but-unstamped rows are revoked with the rest: the
   * context is gone, and there is nobody left to tell "expired" instead.
   */
  async revokeOutstandingWithin(
    tx: Prisma.TransactionClient,
    scope: RevokeOutstandingScope,
  ): Promise<OutstandingInviteRevocation> {
    const now = new Date();
    const events = await this.settleOutstandingWithin(
      tx,
      scope,
      { status: InviteStatus.Revoked, respondedAt: now },
      InviteRevokedEvent,
      now,
    );

    return { count: events.length, events };
  }

  /**
   * Announces the domain events a primitive handed back. A consumer calls this
   * only AFTER its transaction commits.
   *
   * `EventEmitterModule` runs without `ignoreErrors`, so a synchronous listener
   * that throws propagates out of `emit()`. By the time a consumer calls this
   * the transition is committed, and surfacing a listener's failure as the
   * request's failure would report a 500 for an operation that succeeded. Each
   * failure is logged and the remaining domain events still go out.
   */
  emit(events: readonly InviteDomainEvent[]): void {
    for (const event of events) {
      try {
        this.events.emit(event.eventName, event);
      } catch (error) {
        this.logger.error(`Listener failed for ${event.eventName} (invite ${event.subjectId})`, error);
      }
    }
  }

  /**
   * The shape every transition shares: read the row (scoped to the party when
   * there is one), refuse it for the right reason if it cannot move, update it
   * with the status it was read in as the guard, and hand back the view and
   * the domain event.
   */
  private async transitionWithin<Select extends Prisma.InviteSelect, Event extends InviteTransitionEvent>(
    tx: Prisma.TransactionClient,
    spec: TransitionSpec<Select, Event>,
  ): Promise<InviteOutcome<Prisma.InviteGetPayload<{ select: Select }>, Event>> {
    const now = new Date();
    const current =
      spec.partyOf === undefined
        ? await this.loadForTransition(tx, spec.target)
        : await this.loadForParty(tx, spec.target, spec.partyOf);

    spec.assertRole?.(current);
    this.refuseIfExpired(current, now);
    spec.assertStatus(current);

    const after = await this.applyWithin(tx, current, spec.data(now), (latest) => {
      this.refuseIfExpired(latest, now);
      spec.assertStatus(latest);
    });

    return {
      invite: project(after, spec.view),
      event: new spec.event(toInviteSnapshot(current), toInviteSnapshot(after), now),
    };
  }

  /**
   * The context column an invite of this type names, with the other refused.
   *
   * A row carrying both ids would sit inside both context indexes, blocking an
   * unrelated invite to the same person in the other context, and would be
   * revoked when either context closed. A `System` or `Campaign` invite names
   * neither: the campaign column is not on the model yet, and a household or
   * event id on such a row would put it inside an index it does not belong to.
   */
  private contextOf(params: CreateInviteParams): Prisma.InviteWhereInput | null {
    const householdId = params.householdId ?? null;
    const eventId = params.eventId ?? null;

    switch (params.type) {
      case InviteType.Household:
        if (!householdId) {
          throw new BadRequestException(t('errors.invite.household_required'));
        }

        if (eventId) {
          throw new BadRequestException(t('errors.invite.context_mismatch', { type: params.type }));
        }

        return { householdId };
      case InviteType.Event:
        if (!eventId) {
          throw new BadRequestException(t('errors.invite.event_required'));
        }

        if (householdId) {
          throw new BadRequestException(t('errors.invite.context_mismatch', { type: params.type }));
        }

        return { eventId };
      default:
        if (householdId || eventId) {
          throw new BadRequestException(t('errors.invite.context_mismatch', { type: params.type }));
        }

        return null;
    }
  }

  /**
   * Stamps `Expired` on the outstanding rows the new invite would collide with
   * whose window has closed, so the partial unique index no longer counts
   * them. On the caller's transaction, ahead of the insert: the two commit
   * together, and if the insert fails for another reason the stamp is undone
   * with it and the next attempt simply makes it again.
   *
   * Only the pairs the new row will occupy are searched: this invitee's id and
   * address under this context. Nothing else's rows are touched; the sweep
   * (#165) is for those.
   */
  private async expireRivalsWithin(
    tx: Prisma.TransactionClient,
    context: Prisma.InviteWhereInput | null,
    party: { readonly inviteeId: string | null; readonly inviteeEmail: string | null },
    now: Date,
  ): Promise<InviteExpiredEvent[]> {
    if (context === null) {
      return [];
    }

    const parties: Prisma.InviteWhereInput[] = [];

    if (party.inviteeId !== null) {
      parties.push({ inviteeId: party.inviteeId });
    }

    if (party.inviteeEmail !== null) {
      parties.push({ inviteeEmail: party.inviteeEmail });
    }

    return this.settleOutstandingWithin(
      tx,
      { ...context, OR: parties, expiresAt: { lte: now } },
      { status: InviteStatus.Expired },
      InviteExpiredEvent,
      now,
    );
  }

  /**
   * Moves every outstanding row matching `where` to one terminal status, one
   * guarded statement per source status, so each domain event carries the
   * status its row actually left and a row a rival settles in between is
   * simply not returned rather than announced.
   *
   * The statements run in `OUTSTANDING_INVITE_STATUSES` order, which that
   * constant explains: `AwaitingApproval` first, because a rival approve only
   * ever moves a row the other way, and the `Pending` statement then still
   * meets it. The other order let such a row through.
   */
  private async settleOutstandingWithin<Event extends InviteTransitionEvent>(
    tx: Prisma.TransactionClient,
    where: Prisma.InviteWhereInput,
    data: Prisma.InviteUncheckedUpdateManyInput,
    event: InviteTransitionEventClass<Event>,
    now: Date,
  ): Promise<Event[]> {
    const events: Event[] = [];

    for (const from of OUTSTANDING_INVITE_STATUSES) {
      const settled = await tx.invite.updateManyAndReturn({
        where: { ...where, status: from },
        data,
        select: INVITE_SNAPSHOT_SELECT,
      });

      for (const row of settled) {
        // Through the projection, like every other domain event, so a widened
        // select could never carry an extra column onto the payload.
        const after = toInviteSnapshot(row);

        events.push(new event({ ...after, status: from, respondedAt: null }, after, now));
      }
    }

    return events;
  }

  /**
   * Mints a token and checks it is free before the insert.
   *
   * The probe exists because a collision cannot be retried after the fact: a
   * P2002 aborts the caller's transaction, and Prisma opens no savepoint, so
   * the next statement on it fails whatever it is. Checking first is a
   * check-then-act, and the unique index still backstops the race; on 256
   * random bits that race, like the collision itself, is not expected to occur.
   */
  private async mintTokenWithin(tx: Prisma.TransactionClient): Promise<string> {
    for (let attempt = 1; attempt <= INVITE_TOKEN_MINT_ATTEMPTS; attempt += 1) {
      const token = randomBytes(INVITE_TOKEN_BYTES).toString('base64url');
      const taken = await tx.invite.findUnique({ where: { token }, select: { id: true } });

      if (!taken) {
        return token;
      }

      // Never the token itself. A log line is not a place for an accept credential.
      this.logger.warn(
        `Minted invite token collided with an existing row (attempt ${attempt} of ${INVITE_TOKEN_MINT_ATTEMPTS})`,
      );
    }

    throw new InternalServerErrorException(t('errors.invite.token_unavailable'));
  }

  /**
   * Maps an insert failure to what the caller should see.
   *
   * Only a P2002 is translated, and only when it names one of the outstanding
   * uniques. `invites` carries exactly three kinds of uniqueness besides its
   * primary key: the token, which was probed free a statement ago, and the four
   * partial indexes on an outstanding invite's party and context. So an
   * unidentifiable P2002 is answered as a duplicate: of the violations this
   * insert can reach, a 256-bit token colliding in the window after its probe
   * is the one that does not happen. `apps/api-e2e/src/invite` guards that
   * enumeration against the live schema.
   */
  private translateCreateFailure(error: unknown): unknown {
    if (!isPrismaUniqueConstraintError(error)) {
      return error;
    }

    const identity = constraintIdentity(error);

    if (
      identifiesConstraint(
        identity,
        ...OUTSTANDING_INVITE_UNIQUE_COLUMNS,
        ...OUTSTANDING_INVITE_UNIQUE_FIELDS,
        ...OUTSTANDING_INVITE_UNIQUE_INDEXES.map((name) => [name]),
      )
    ) {
      return new ConflictException(t('errors.invite.already_outstanding'));
    }

    if (identifiesConstraint(identity, INVITE_TOKEN_UNIQUE_COLUMNS)) {
      // The probe said free and the insert said taken. Not a client error and
      // not retryable here (the transaction is aborted); the payload is left
      // out of the line because it is the one place the token could appear.
      this.logger.error('Invite token collided at insert after its probe reported it free', error);

      return error;
    }

    if (identity.source === 'unknown') {
      // Could not tell which unique fired, which is not the same as knowing it
      // was a different one; see the enumeration above for why 409 is the
      // honest answer. Warn rather than debug: reaching this means the payload
      // stopped carrying an identity, and a log line beats a wrong status.
      this.logger.warn(
        `Could not identify the unique behind an invite-insert P2002; answering 409 as a duplicate outstanding ` +
          `invite. sqlState=${identity.sqlState ?? 'unreported'}`,
      );

      return new ConflictException(t('errors.invite.already_outstanding'));
    }

    if (isIdentifiedConstraint(identity)) {
      this.logger.error(
        `Invite insert hit an unexpected unique; source=${identity.source} names=${JSON.stringify(identity.names)}`,
        error,
      );
    }

    return error;
  }

  /**
   * The row as a PARTY reaches it, or 404. The `where` binds to the acting
   * user as inviter or invitee, so a stranger addressing an invite by id or
   * by a link that is not theirs meets a miss rather than a refusal that
   * confirms the invite exists. By token, an email-only row (no invitee yet)
   * is reachable too: the link is how its invitee arrives.
   */
  private async loadForParty(
    client: ReadClient,
    target: InviteTarget,
    actingUserId: string,
  ): Promise<InviteTransitionRow> {
    const parties: Prisma.InviteWhereInput[] = [{ inviterId: actingUserId }, { inviteeId: actingUserId }];

    if ('token' in target) {
      parties.push({ inviteeId: null });
    }

    const row = await client.invite.findFirst({
      where: { ...this.whereTarget(target), OR: parties },
      select: TRANSITION_SELECT,
    });

    return row ?? this.refuseMissing(target);
  }

  /**
   * The row as a CONTEXT AUTHORITY reaches it, or 404. No party binding: the
   * caller asserted the authority before calling, which is the one check the
   * lib never makes. Also the re-read behind a guard miss, where the party was
   * already established.
   */
  private async loadForTransition(tx: Prisma.TransactionClient, target: InviteTarget): Promise<InviteTransitionRow> {
    const row = await tx.invite.findFirst({ where: this.whereTarget(target), select: TRANSITION_SELECT });

    return row ?? this.refuseMissing(target);
  }

  private whereTarget(target: InviteTarget): Prisma.InviteWhereInput {
    return 'inviteId' in target ? { id: target.inviteId } : { token: target.token };
  }

  /** A token miss never echoes the token. */
  private refuseMissing(target: InviteTarget): never {
    throw new NotFoundException(
      'inviteId' in target ? t('errors.invite.not_found', { id: target.inviteId }) : t('errors.invite.link_not_found'),
    );
  }

  /**
   * The row is the actor's; is it theirs to answer? A user-bound invite
   * answers to its invitee, by id or by token. An email-only invite has no
   * invitee id and answers to whoever holds its link; addressed by id it
   * answers to nobody, which is the point: the id reaches every context reader
   * through the household detail, the token does not.
   *
   * The inviter never answers, by either route. Create refuses a self-invite
   * by id but cannot tell that an address is the inviter's own; without this
   * the link such an invite mails them would let them accept it.
   */
  private assertInvitee(current: InviteTransitionRow, target: InviteTarget, actingUserId: string): void {
    const isInviter = current.inviterId === actingUserId;
    const reachable = current.inviteeId === actingUserId || (current.inviteeId === null && 'token' in target);

    if (isInviter || !reachable) {
      throw new ForbiddenException(t('errors.invite.only_invitee_responds'));
    }
  }

  private assertInviter(current: InviteTransitionRow, actingUserId: string): void {
    if (current.inviterId !== actingUserId) {
      throw new ForbiddenException(t('errors.invite.only_inviter_withdraws'));
    }
  }

  private assertFrom(current: InviteTransitionRow, allowed: readonly InviteStatus[]): void {
    if (!allowed.includes(current.status)) {
      throw new ConflictException(t('errors.invite.not_outstanding', { id: current.id, status: current.status }));
    }
  }

  /**
   * A transition that meets an outstanding row past its date persists
   * `Expired` and refuses. Only an outstanding row can expire; a settled one
   * falls through to the status check, which names its real status.
   *
   * The stamp is started, not awaited. The caller's transaction holds one pool
   * connection and the stamp needs another; a refusal that waited for it while
   * holding the first would, under a pool full of such requests, wait on
   * itself until the pool timeout and turn every 410 into a 500. Thrown at
   * once, the refusal rolls the transaction back and frees its connection, and
   * the stamp takes the next one that comes free.
   */
  private refuseIfExpired(current: InviteTransitionRow, now: Date): void {
    if (!isOutstandingInviteStatus(current.status) || current.expiresAt > now) {
      return;
    }

    void this.persistExpiry(current, now);

    throw new GoneException(t('errors.invite.expired', { id: current.id }));
  }

  /**
   * Written on the lib's own connection, NOT the caller's transaction, on
   * purpose: the refusal that follows is thrown, which rolls the caller's
   * transaction back, and the stamp has to outlive it. The statement is
   * guarded on the status the row was read in and on the date, so a rival
   * transition or #165's sweep landing first leaves nothing for it to do, and
   * the domain event is announced only when this statement is the one that
   * moved the row. Emitted as soon as the write lands, since it is committed.
   *
   * Nothing waits on this, so a failure here can only be logged: the refusal
   * already went out as the 410 it was, and the row is refused again on its
   * next transition and converged by #165's sweep regardless. A consumer that
   * updated the invite row inside its own transaction before calling would
   * hold the lock this statement needs; the statement then waits for that
   * transaction to end, and the request does not wait for the statement.
   */
  private async persistExpiry(current: InviteTransitionRow, now: Date): Promise<void> {
    try {
      const { count } = await this.db.invite.updateMany({
        where: { id: current.id, status: current.status, expiresAt: { lte: now } },
        data: { status: InviteStatus.Expired },
      });

      if (count === 1) {
        const before = toInviteSnapshot(current);

        this.emit([new InviteExpiredEvent(before, { ...before, status: InviteStatus.Expired }, now)]);
      }
    } catch (error) {
      this.logger.error(`Could not stamp invite ${current.id} Expired after refusing a transition on it`, error);
    }
  }

  /**
   * The guarded update: the status the row was read in goes in the `where`,
   * so a rival transition that landed since leaves this one unmatched.
   * `updateManyAndReturn` rather than `update`, so a miss is an empty result
   * and not an exception inside the caller's transaction.
   *
   * On a miss the row is re-read and `reclassify` reports the transition it
   * now refuses: a rival accept makes this one "already accepted", a rival
   * sweep makes it "expired". Only when the row would still allow this
   * transition, as when a rival approve moved it from AwaitingApproval to
   * Pending in between, is the answer a bare "try again".
   */
  private async applyWithin(
    tx: Prisma.TransactionClient,
    current: InviteTransitionRow,
    data: Prisma.InviteUncheckedUpdateManyInput,
    reclassify: (latest: InviteTransitionRow) => void,
  ): Promise<InviteTransitionRow> {
    const [after] = await tx.invite.updateManyAndReturn({
      where: { id: current.id, status: current.status },
      data,
      select: INVITE_SNAPSHOT_SELECT,
    });

    if (!after) {
      const latest = await this.loadForTransition(tx, { inviteId: current.id });

      reclassify(latest);

      throw new ConflictException(t('errors.invite.changed_concurrently', { id: current.id }));
    }

    return { ...current, ...after };
  }
}
