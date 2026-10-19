import { Action, DatabaseService, HUMAN_USER_WHERE, InviteType, Prisma, ResourceType, SystemRole } from '@bge/database';
import { t } from '@bge/i18n';
import {
  CONTEXT_INVITE_SELECT,
  DEFAULT_INVITE_TTL_MS,
  effectiveInviteStatusWhere,
  gateInvitee,
  INVITE_SCALARS_PARTY_ONLY,
  InviteService,
  OUTSTANDING_INVITE_STATUSES,
  unexpiredInviteWhere,
  withEffectiveInviteStatus,
  type InviteContextView,
  type InviteDomainEvent,
  type InvitePartyView,
  type StoredInvitee,
} from '@bge/invites';
import { AbilityService, resolveActingUserIdOrNull, ScopeComposer } from '@bge/permissions';
import { QuotaExceededException, QuotaService, type QuotaCheckContext, type QuotaSoftOverageEvent } from '@bge/quota';
import { PaginatedRows } from '@bge/shared';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateHouseholdInviteDto, ListHouseholdInvitesQueryDto, type AssignableHouseholdRole } from '../dto';
import { assertHouseholdExists, lockExistingHousehold, resolveHouseholdRoleId } from '../household-access.helpers';
import { SHOWN_NAME_SELECT, shownName } from '../shown-name';
import { isHouseholdAuthority, ROSTER_ROLE_SELECT, type RosterRow } from './household-authority';

/**
 * The household setting a member's invite is asked about (#166): whether
 * members may invite, and whether their invite waits for approval.
 */
const INVITE_SETTINGS_SELECT = { memberInvitePolicy: true } as const satisfies Prisma.HouseholdSettingsSelect;

/**
 * The column each existing-invite check names. A revoke and an approve share
 * an action and a resource type, and their permissions are told apart by these
 * alone (#166): a check that named none would pass either permission.
 */
const REVOKE_FIELD = Prisma.InviteScalarFieldEnum.status;
const APPROVE_FIELD = Prisma.InviteScalarFieldEnum.approvedById;

/**
 * The columns the party shape adds to the context shape, read only for rows
 * the reader sent. Built from the lib's own ledger of party-only columns, so a
 * column it adds there is fetched here without an edit.
 */
const PARTY_COLUMNS_SELECT = {
  id: true,
  ...(Object.fromEntries(Object.keys(INVITE_SCALARS_PARTY_ONLY).map((key) => [key, true])) as {
    readonly [Key in keyof typeof INVITE_SCALARS_PARTY_ONLY]: true;
  }),
} as const satisfies Prisma.InviteSelect;

/**
 * The column the authority shape adds to the context shape, read for the
 * household's owners and admins (#167): the address, and never the message,
 * which is addressed to the invitee and stays on the rows the reader sent.
 */
const AUTHORITY_COLUMNS_SELECT = { id: true, inviteeEmail: true } as const satisfies Prisma.InviteSelect;

/**
 * The context shape plus the address, for the household's own owners and
 * admins (#167), who always see who is invited to their household.
 */
export type InviteAuthorityView = InviteContextView & { readonly inviteeEmail: string | null };

/**
 * A listed invite: the party shape on a row the reader sent; on every other,
 * the authority shape for the household's owners and admins (#167), and the
 * context shape for anyone else.
 */
export type HouseholdInviteView = InvitePartyView | InviteAuthorityView | InviteContextView;

/** Who the request names, once exactly one of the two fields is known to be there. */
type InviteeRequest = { readonly inviteeId: string } | { readonly inviteeEmail: string };

/** The invitee as `createWithin` stores it. */
type ResolvedInvitee = StoredInvitee & { readonly inviteeName: string | null };

/**
 * Creates, lists, revokes and approves a household's invites (#162, #164,
 * #166). The lifecycle itself is `@bge/invites`'s; this is the household's
 * side of it: who may invite, revoke or approve, whether an invite waits for
 * approval, whom an address names, and who sees which rows.
 */
@Injectable()
export class HouseholdInviteService {
  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
    private readonly invites: InviteService,
    private readonly quotas: QuotaService,
  ) {}

  /**
   * Opens an invite into the household, in one transaction:
   *
   * 1. The caller must hold `create` on an invite into THIS household. The
   *    route's type-only check passes any holder of `create:event_invite`, down
   *    to an event participant, and only the instance reads the role clause.
   *    Asked before the lock, so a caller with no say here is refused without
   *    holding the household's row.
   * 2. The household row is share-locked. A soft delete revokes every
   *    outstanding invite in its own transaction, and the insert's foreign key
   *    takes only `FOR KEY SHARE`, which does not block the delete's update;
   *    without the lock, an invite inserted after the revoke would stay
   *    `Pending` in a deleted household.
   * 3. The question is asked again of the roster read under the lock, and that
   *    answer decides: a role change can land between the first read and the
   *    lock, and none can land after it. It also decides whether the invite
   *    waits for approval (#166), from the household's member invite policy
   *    read beside the roster ({@link assertMayInvite}).
   * 4. The invitee is resolved: an id must be a person's, and an address is
   *    stored as it is, bound to no account. The inviter is refused, and so is
   *    a current member named by id.
   * 5. The server's policy, a block between the two and the invitee's own
   *    preference decide whether they may be invited (#278). By id, each
   *    refuses with 403. By address, only the policy refuses; the other two
   *    store the invite withheld, and it answers like any other.
   * 6. The invite takes one of the inviter's and the household's invites for
   *    the day (#279), under the cap's advisory lock, so two invites at once
   *    cannot both take the last one. One that waits for approval takes only
   *    the inviter's: the household's is taken when it is approved, so a
   *    member's proposals cannot spend the household's day. A refused invite
   *    never gets here and takes none; a withheld one takes one like any
   *    other. Past a hard cap the answer is 402.
   * 7. The lib inserts. A second outstanding invite to the same id, or to the
   *    same address, is the database's 409, through the lib.
   *
   * The domain events go out after commit, in the order the writes happened:
   * any expired rivals the lib stamped on the way, then the created invite.
   * Any soft cap the invite went past is warned of after them.
   */
  async createInvite(householdId: string, dto: CreateHouseholdInviteDto): Promise<InvitePartyView> {
    const inviterId = this.abilityService.getActingUserId();
    const request = this.inviteeRequestOf(dto);
    const role = dto.role ?? SystemRole.HouseholdMember;

    const { invite, event, expired, softOverages } = await this.db.$transaction(async (tx) => {
      await this.assertMayInvite(tx, householdId, role);
      await lockExistingHousehold(tx, householdId);

      const { members, needsApproval } = await this.assertMayInvite(tx, householdId, role);

      const invitee = await this.resolveInvitee(tx, request, inviterId, dto.inviteeName ?? null);

      // Accepting would leave a member's role as it is, so the invite would
      // offer nothing. The roster lock does not stop an admission, which takes
      // the same share lock, from landing after this read; the accept (#163)
      // meets a member in that case, as it does when one joins by another
      // route after being invited.
      if (invitee.inviteeId !== null && members.some((member) => member.userId === invitee.inviteeId)) {
        throw new ConflictException(t('errors.household.invitee_already_member', { householdId }));
      }

      const roleId = await resolveHouseholdRoleId(tx, role);

      const { withheld } = await gateInvitee(tx, InviteType.Household, inviterId, invitee);

      const softOverages = await this.takeDailyInvite(
        tx,
        needsApproval ? { userId: inviterId } : { userId: inviterId, householdId },
      );

      const created = await this.invites.createWithin(tx, {
        type: InviteType.Household,
        inviterId,
        householdId,
        ...invitee,
        roleId,
        message: dto.message ?? null,
        withheld,
        needsApproval,
      });

      return { ...created, softOverages };
    });

    this.invites.emit([...expired, event]);
    this.quotas.emitSoftOverages(softOverages);

    return invite;
  }

  /**
   * Cancels an invite someone else sent into the household (#164), in one
   * transaction, in the order the create takes:
   *
   * 1. The caller must hold `update` on this invite into THIS household, asked
   *    of the instance: the route's type-only check passes the Owner or Admin
   *    of any household. The instance carries the invite's id, so a key scoped
   *    to this one invite is asked about it. Asked before the lock, so a caller
   *    with no say here is refused without holding the household's row.
   * 2. The household row is share-locked. A role transition takes the same
   *    row `FOR NO KEY UPDATE`, which conflicts, so no demotion lands between
   *    the answer below and the revoke; and a soft delete, which locks the row
   *    before it revokes every outstanding invite, is ordered with this one
   *    rather than deadlocking against it.
   * 3. The question is asked again of the roster read under the lock, and that
   *    answer decides.
   * 4. The lib revokes, bound to this household: 404 for an id from another
   *    one, 403 for the invite's own inviter, who withdraws it instead, 410
   *    once expired, 409 once settled.
   *
   * The revoked invite is announced after commit. The row stays, so it still
   * counts against the day's invite quotas it was counted against (#279).
   * A revoker who is one of the household's owners or admins gets the address
   * with it (#167).
   */
  async revokeInvite(householdId: string, inviteId: string): Promise<InviteContextView | InviteAuthorityView> {
    const revokerId = this.abilityService.getActingUserId();

    return this.transitionAsAuthority(householdId, inviteId, revokerId, REVOKE_FIELD, (tx, scope) =>
      this.invites.revokeWithin(tx, { inviteId, revokerId, scope }),
    );
  }

  /**
   * Opens a member's invite awaiting approval to its invitee (#166), in the
   * order a revoke takes:
   *
   * 1. The acting user must hold `update` on this invite's `approvedById` in
   *    THIS household, asked of the instance before the lock. Naming the
   *    column keeps the revoke permission, bound to `status`, from passing for
   *    it.
   * 2. The household row is share-locked, so no demotion lands between the
   *    answer below and the approval.
   * 3. The question is asked again of the roster read under the lock, and that
   *    answer decides.
   * 4. The invite takes one of the household's invites for the day (#279),
   *    the one it did not take when it was sent: 402 past a hard cap. The
   *    inviter's was taken then. A full cap answers ahead of the invite's own
   *    state below.
   * 5. The lib approves, bound to this household: 404 for an id from another
   *    one, 410 once expired, 409 unless it is awaiting approval.
   *
   * The invitee gets the full window a direct invite opens with, counted from
   * the approval, so the time the invite waited for an approver does not come
   * out of the invitee's time to answer it.
   *
   * The household's member invite policy is not read: a change to it applies
   * to the invites sent after it, so an invite sent for approval stays
   * approvable after a switch to `Direct` or to `Off`. An approver may approve
   * an invite they sent themselves, as a member promoted since.
   *
   * The approved invite is announced after commit, and any soft cap it went
   * past is warned of after it. An approver who is one of the household's
   * owners or admins gets the address with it (#167).
   */
  async approveInvite(householdId: string, inviteId: string): Promise<InviteContextView | InviteAuthorityView> {
    const approverId = this.abilityService.getActingUserId();

    return this.transitionAsAuthority(householdId, inviteId, approverId, APPROVE_FIELD, async (tx, scope) => {
      const softOverages = await this.takeDailyInvite(tx, { householdId });
      const approval = await this.invites.approveWithin(tx, {
        inviteId,
        approverId,
        scope,
        expiresAt: new Date(Date.now() + DEFAULT_INVITE_TTL_MS),
      });

      return { ...approval, softOverages };
    });
  }

  /**
   * One invite moved by the household's authority over it, as a revoke and an
   * approve move one, in one transaction: asked of the instance about the
   * column the transition changes, the household row share-locked, asked again
   * of the roster read under the lock, then the lib's transition, bound to this
   * household. Its domain event is announced after commit, then any soft cap
   * the transition went past.
   *
   * The lib answers in the context shape. When that roster names the actor one
   * of the household's owners or admins, the address is read on the same
   * transaction and added (#167). It is read after the transition, which
   * refuses an invite from another household, so no other household's address
   * is read. The answer is decided by the roster, not by the grant that let the
   * actor move the invite.
   */
  private async transitionAsAuthority(
    householdId: string,
    inviteId: string,
    actorId: string,
    field: Prisma.InviteScalarFieldEnum,
    transition: (
      tx: Prisma.TransactionClient,
      scope: { readonly householdId: string },
    ) => Promise<{
      readonly invite: InviteContextView;
      readonly event: InviteDomainEvent;
      readonly softOverages?: readonly QuotaSoftOverageEvent[];
    }>,
  ): Promise<InviteContextView | InviteAuthorityView> {
    const { invite, event, softOverages } = await this.db.$transaction(async (tx) => {
      await this.assertInviteAuthority(tx, householdId, Action.update, { inviteId, field });
      await lockExistingHousehold(tx, householdId);
      const members = await this.assertInviteAuthority(tx, householdId, Action.update, { inviteId, field });

      const moved = await transition(tx, { householdId });

      if (!isHouseholdAuthority(members, actorId)) {
        return moved;
      }

      const address = await tx.invite.findUniqueOrThrow({ where: { id: inviteId }, select: AUTHORITY_COLUMNS_SELECT });

      return { ...moved, invite: { ...moved.invite, ...address } };
    });

    this.invites.emit([event]);
    this.quotas.emitSoftOverages(softOverages ?? []);

    return invite;
  }

  /**
   * Takes one invite from the day's allowance of each scope `charged` names
   * (#279), on the caller's transaction and under the cap's advisory lock, so
   * the write that follows in it cannot overshoot a hard cap: 402 past one.
   * Hands back the soft caps it went past, for the caller to warn of after
   * commit.
   */
  private async takeDailyInvite(
    tx: Prisma.TransactionClient,
    charged: QuotaCheckContext,
  ): Promise<readonly QuotaSoftOverageEvent[]> {
    const decision = await this.quotas.consume('household_invite_daily_count', 1n, charged, tx);

    if (!decision.allowed) {
      throw new QuotaExceededException(
        // eslint-disable-next-line no-restricted-syntax -- quota metric key, not user copy; QuotaExceededException localizes its message in @bge/quota
        'household_invite_daily_count',
        decision.scope!,
        decision.limit!,
        decision.currentUsage!,
        1n,
      );
    }

    return decision.softOverages;
  }

  /**
   * One page of the household's invites, newest first (#162).
   *
   * The caller must hold `read` on this household's invites, asked of the
   * instance as the create asks it: the route's type-only check passes anyone
   * who administers SOME household, and without this an admin of another
   * household would get an empty page rather than a 403. It is asked before the
   * household's liveness, as the create asks it before the lock, so only a
   * caller who may read the invites learns that the household is gone. The
   * rows then compose under the same grant, so staff, who read every invite,
   * see this household's rows and no other household's.
   *
   * Every row is read in the context shape. The party columns, the address and
   * the message, are then read for the rows the caller sent. When the roster
   * names the caller one of the household's owners or admins, the address
   * alone is read for every other row (#167): they always see who is invited
   * to their household, and the message stays with the parties. Anyone else
   * gets nothing more, so another inviter's address never leaves the database
   * for them. Staff read every invite through a grant, and a grant is not a
   * household role: they see the address only where the roster names them a
   * household owner or household admin. Those columns do not change after the
   * insert, so the later reads need no snapshot shared with the first. Each
   * row's status is the one it has now, from the same `now` the filter used.
   */
  async listInvites(
    householdId: string,
    query: ListHouseholdInvitesQueryDto,
  ): Promise<PaginatedRows<HouseholdInviteView>> {
    const members = await this.assertInviteAuthority(this.db, householdId, Action.read);
    await assertHouseholdExists(this.db, householdId);

    const readerId = resolveActingUserIdOrNull(this.abilityService);
    const now = new Date();
    const statusWhere =
      query.status === undefined
        ? { status: { in: [...OUTSTANDING_INVITE_STATUSES] }, ...unexpiredInviteWhere(now) }
        : effectiveInviteStatusWhere(query.status, now);
    const where = this.scopeComposer.compose(ResourceType.Invite, Action.read, { householdId, AND: [statusWhere] });

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

    const sent = readerId === null ? [] : rows.filter((row) => row.inviter.id === readerId).map((row) => row.id);
    const others = isHouseholdAuthority(members, readerId)
      ? rows.filter((row) => row.inviter.id !== readerId).map((row) => row.id)
      : [];
    const [partyColumns, addresses] = await Promise.all([
      readerId === null || sent.length === 0
        ? []
        : this.db.invite.findMany({
            where: { id: { in: sent }, inviterId: readerId },
            select: PARTY_COLUMNS_SELECT,
          }),
      others.length === 0
        ? []
        : this.db.invite.findMany({
            where: { id: { in: others }, householdId },
            select: AUTHORITY_COLUMNS_SELECT,
          }),
    ]);
    const columnsById = new Map([...partyColumns, ...addresses].map((columns) => [columns.id, columns]));

    return {
      rows: rows.map((row): HouseholdInviteView => {
        const columns = columnsById.get(row.id);

        return withEffectiveInviteStatus(columns ? { ...row, ...columns } : row, now);
      }),
      total,
    };
  }

  /**
   * Exactly one of the two fields names the invitee. A JSON `null` counts as
   * absent: the DTO's `@IsOptional` lets it through, and it names nobody.
   */
  private inviteeRequestOf(dto: CreateHouseholdInviteDto): InviteeRequest {
    const inviteeId = dto.inviteeId ?? null;
    const inviteeEmail = dto.inviteeEmail ?? null;

    if (inviteeId !== null && inviteeEmail === null) {
      return { inviteeId };
    }

    if (inviteeEmail !== null && inviteeId === null) {
      return { inviteeEmail };
    }

    throw new BadRequestException(t('errors.household.invitee_exactly_one'));
  }

  /**
   * Whether the acting user may invite into this household, offering `role`,
   * as `client` reads the household's roster and member invite policy (#166)
   * in one query, and if so how the invite opens: directly, or awaiting
   * approval. Refuses with 403 when they may do neither. A missing household
   * reads as an empty roster with no policy, and the lock answers it 404.
   *
   * Two questions, in order, since the catalog holds the answer: whether they
   * may open the invite directly, as an owner or admin always may and a member
   * may under `Direct`; and if not, whether they may open it awaiting approval,
   * as a member may under `NeedsApproval`. The client never says which. A
   * household with no settings row has no policy for a member's permissions to
   * match, so a member is refused there.
   *
   * The household lock does not order a policy change against this read, and
   * need not: a change applies to the invites sent after it, and one that
   * commits after this read finds this invite already sent.
   */
  private async assertMayInvite(
    client: Prisma.TransactionClient,
    householdId: string,
    role: AssignableHouseholdRole,
  ): Promise<{ readonly members: RosterRow[]; readonly needsApproval: boolean }> {
    const household = await client.household.findUnique({
      where: { id: householdId },
      select: { settings: { select: INVITE_SETTINGS_SELECT }, members: { select: ROSTER_ROLE_SELECT } },
    });
    const settings = household?.settings ?? null;
    const members = household?.members ?? [];

    const invite = (needsApproval: boolean) => ({
      householdId,
      needsApproval,
      role: { name: role },
      household: { settings, members },
    });

    if (this.abilityService.currentActorCan(Action.create, ResourceType.Invite, invite(false))) {
      return { members, needsApproval: false };
    }

    this.abilityService.assertCurrentActorCan(Action.create, ResourceType.Invite, invite(true));

    return { members, needsApproval: true };
  }

  /**
   * Asks whether the acting user may `action` an invite into this household,
   * of the household's roster as `client` reads it.
   *
   * An action on an existing invite names it by `inviteId`. An API key scoped
   * to one invite holds its grant only on that id, so an instance without one
   * would refuse the key even on the invite it was scoped to. It also names
   * the column it changes (`field`), which is all that tells the revoke
   * permission from the approve permission.
   *
   * Hands back the roster it asked of, which says whether the acting user is
   * one of the household's owners or admins and so sees the address (#167).
   */
  private async assertInviteAuthority(
    client: DatabaseService | Prisma.TransactionClient,
    householdId: string,
    action: typeof Action.read | typeof Action.update,
    existing?: { readonly inviteId: string; readonly field: Prisma.InviteScalarFieldEnum },
  ): Promise<RosterRow[]> {
    const members = await this.rosterOf(client, householdId);

    this.abilityService.assertCurrentActorCan(
      action,
      ResourceType.Invite,
      { ...(existing === undefined ? {} : { id: existing.inviteId }), householdId, household: { members } },
      existing?.field,
    );

    return members;
  }

  /** Each member's user id and household role, as `client` reads them. */
  private rosterOf(client: DatabaseService | Prisma.TransactionClient, householdId: string): Promise<RosterRow[]> {
    return client.householdMember.findMany({ where: { householdId }, select: ROSTER_ROLE_SELECT });
  }

  /**
   * The invitee as the lib stores it.
   *
   * By id: the user must exist and be a person. The server's service account
   * cannot sign in, and an anonymous guest's account is deleted when the guest
   * signs in for real, which the invite's foreign key would leave as an invite
   * to nobody; either is not found. With no name given, the account's display
   * name (or, when it has none or a blank one, its username) is stored, so the
   * household's view of the invite names someone; an invite by id already says
   * who the account is.
   *
   * By address: the address is stored alone (the lib trims and lower-cases
   * it), with the name as typed, and no account is bound. Whatever the create
   * did with the account holding the address would show in how it answers: a
   * bound id meets the duplicate index, and a member is refused. Either would
   * tell the inviter whose address it is. The gate (#278) does read that
   * account's block and preference, but only to withhold the invite, which no
   * answer shows. The accept (#163) binds the account that answers the invite.
   *
   * The inviter is refused by either route: by id, or by their own address,
   * which tells them nothing. Addresses are compared lower-cased.
   */
  private async resolveInvitee(
    tx: Prisma.TransactionClient,
    request: InviteeRequest,
    inviterId: string,
    inviteeName: string | null,
  ): Promise<ResolvedInvitee> {
    if ('inviteeEmail' in request) {
      const inviter = await tx.user.findUnique({ where: { id: inviterId }, select: { email: true } });

      if (inviter?.email.toLowerCase() === request.inviteeEmail.toLowerCase()) {
        throw new BadRequestException(t('errors.invite.self_invite'));
      }

      return { inviteeId: null, inviteeEmail: request.inviteeEmail, inviteeName };
    }

    const user = await tx.user.findUnique({
      where: { id: request.inviteeId, ...HUMAN_USER_WHERE },
      select: { id: true, ...SHOWN_NAME_SELECT },
    });

    if (!user) {
      throw new NotFoundException(t('errors.user.not_found', { id: request.inviteeId }));
    }

    // The lib refuses a self-invite by id too, but only after the member check
    // here would have answered 409.
    if (user.id === inviterId) {
      throw new BadRequestException(t('errors.invite.self_invite'));
    }

    return {
      inviteeId: user.id,
      inviteeEmail: null,
      inviteeName: inviteeName ?? shownName(user),
    };
  }
}
