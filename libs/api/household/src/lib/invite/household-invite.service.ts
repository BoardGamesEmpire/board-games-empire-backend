import { Action, DatabaseService, HUMAN_USER_WHERE, InviteType, Prisma, ResourceType, SystemRole } from '@bge/database';
import { t } from '@bge/i18n';
import {
  CONTEXT_INVITE_SELECT,
  effectiveInviteStatusWhere,
  INVITE_SCALARS_PARTY_ONLY,
  InviteService,
  OUTSTANDING_INVITE_STATUSES,
  unexpiredInviteWhere,
  withEffectiveInviteStatus,
  type InviteContextView,
  type InvitePartyView,
} from '@bge/invites';
import { AbilityService, resolveActingUserIdOrNull, ScopeComposer } from '@bge/permissions';
import { QuotaExceededException, QuotaService } from '@bge/quota';
import { PaginatedRows } from '@bge/shared';
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { CreateHouseholdInviteDto, ListHouseholdInvitesQueryDto } from '../dto';
import { assertHouseholdExists, lockExistingHousehold, resolveHouseholdRoleId } from '../household-access.helpers';
import { gateInvitee, type StoredInvitee } from './invitee-gate';

/**
 * Each member's user id and household role: what the invite grants' role
 * clause reads off an instance. Both routes ask about the household's whole
 * roster, as the condition is written over it: a roster cut down to the
 * caller's own row answers today's `some` clause the same, but would pass a
 * `none` or `every` clause it should refuse.
 */
const ROSTER_ROLE_SELECT = {
  userId: true,
  role: { select: { role: { select: { name: true } } } },
} as const satisfies Prisma.HouseholdMemberSelect;

type RosterRow = Prisma.HouseholdMemberGetPayload<{ select: typeof ROSTER_ROLE_SELECT }>;

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
 * A listed invite: the party shape on a row the reader sent, the context shape
 * on every other.
 */
export type HouseholdInviteView = InvitePartyView | InviteContextView;

/** Who the request names, once exactly one of the two fields is known to be there. */
type InviteeRequest = { readonly inviteeId: string } | { readonly inviteeEmail: string };

/** The invitee as `createWithin` stores it. */
type ResolvedInvitee = StoredInvitee & { readonly inviteeName: string | null };

/**
 * Creates and lists a household's invites (#162). The lifecycle itself is
 * `@bge/invites`'s; this is the household's side of it: who may invite, whom
 * an address names, and who sees which rows.
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
   *    lock, and none can land after it.
   * 4. The invitee is resolved: an id must be a person's, and an address is
   *    stored as it is, bound to no account. The inviter is refused, and so is
   *    a current member named by id.
   * 5. The server's policy, a block between the two and the invitee's own
   *    preference decide whether they may be invited (#278). By id, each
   *    refuses with 403. By address, only the policy refuses; the other two
   *    store the invite withheld, and it answers like any other.
   * 6. The invite takes one of the inviter's and the household's invites for
   *    the day (#279), under the cap's advisory lock, so two invites at once
   *    cannot both take the last one. A refused invite never gets here and
   *    takes none; a withheld one takes one like any other. Past a hard cap
   *    the answer is 402.
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
      await this.assertInviteAuthority(tx, householdId, Action.create);
      await lockExistingHousehold(tx, householdId);

      const members = await this.assertInviteAuthority(tx, householdId, Action.create);

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

      const { withheld } = await gateInvitee(tx, inviterId, invitee);

      const decision = await this.quotas.consume(
        'household_invite_daily_count',
        1n,
        { userId: inviterId, householdId },
        tx,
      );

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

      const created = await this.invites.createWithin(tx, {
        type: InviteType.Household,
        inviterId,
        householdId,
        ...invitee,
        roleId,
        message: dto.message ?? null,
        withheld,
      });

      return { ...created, softOverages: decision.softOverages };
    });

    this.invites.emit([...expired, event]);
    this.quotas.emitSoftOverages(softOverages);

    return invite;
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
   * the message, are then read for the rows the caller sent and no others, so
   * another inviter's address never leaves the database for this request.
   * Those columns do not change after the insert, so the second read needs no
   * snapshot shared with the first. Each row's status is the one it has now,
   * from the same `now` the filter used.
   */
  async listInvites(
    householdId: string,
    query: ListHouseholdInvitesQueryDto,
  ): Promise<PaginatedRows<HouseholdInviteView>> {
    await this.assertInviteAuthority(this.db, householdId, Action.read);
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
    const partyColumns =
      readerId === null || sent.length === 0
        ? []
        : await this.db.invite.findMany({
            where: { id: { in: sent }, inviterId: readerId },
            select: PARTY_COLUMNS_SELECT,
          });
    const partyById = new Map(partyColumns.map((columns) => [columns.id, columns]));

    return {
      rows: rows.map((row): HouseholdInviteView => {
        const party = partyById.get(row.id);

        return withEffectiveInviteStatus(party ? { ...row, ...party } : row, now);
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
   * Asks whether the caller may `action` an invite into this household, of the
   * household's roster as `client` reads it, and hands the roster back.
   */
  private async assertInviteAuthority(
    client: DatabaseService | Prisma.TransactionClient,
    householdId: string,
    action: typeof Action.create | typeof Action.read,
  ): Promise<RosterRow[]> {
    const members = await client.householdMember.findMany({ where: { householdId }, select: ROSTER_ROLE_SELECT });

    this.abilityService.assertCurrentActorCan(action, ResourceType.Invite, { householdId, household: { members } });

    return members;
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
      select: { id: true, username: true, profile: { select: { displayName: true } } },
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
      inviteeName: inviteeName ?? (user.profile?.displayName || user.username),
    };
  }
}
