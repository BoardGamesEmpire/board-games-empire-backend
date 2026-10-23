import {
  Action,
  constraintIdentity,
  DatabaseService,
  gameShareSnapshot,
  HouseholdMembershipOrigin,
  identifiesConstraint,
  isIdentifiedConstraint,
  isPrismaDependentRecordNotFoundError,
  isPrismaUniqueConstraintError,
  Prisma,
  ResourceType,
  SystemRole,
  type ConstraintIdentity,
  type GameShare,
} from '@bge/database';
import { t } from '@bge/i18n';
import { InviteService } from '@bge/invites';
import { AbilityService, PermissionsService, ScopeComposer } from '@bge/permissions';
import { QuotaExceededException, QuotaService, type QuotaSoftOverageEvent } from '@bge/quota';
import { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { webhookEnvelope, WebhookEventType } from '@bge/webhooks';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  HOUSEHOLD_MEMBER_UNIQUE_COLUMNS,
  HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT,
  HOUSEHOLD_MEMBER_UNIQUE_FIELDS,
} from '../constants/household.constants';
import { isAssignableHouseholdRole, UpdateMemberRoleDto, type AssignableHouseholdRole } from '../dto';
import {
  HouseholdGameShareEndedEvent,
  HouseholdOwnershipTransferredEvent,
  type HouseholdOwnershipSnapshot,
} from '../events/household.events';
import {
  assertHouseholdExists,
  lockExistingHousehold,
  lockHouseholdForRoleTransition,
  resolveHouseholdRoleId,
} from '../household-access.helpers';
import { ROSTER_ROLE_SELECT } from '../invite/household-authority';
import { MEMBER_SELECT } from '../read-shapes';

export type HouseholdMemberWithRelations = Prisma.HouseholdMemberGetPayload<{ select: typeof MEMBER_SELECT }>;

/**
 * Both sides of a completed ownership transfer. The client needs both rows to
 * reconcile its roster in one round trip — returning only the household would
 * force a follow-up roster fetch to learn who is now Admin.
 */
export interface OwnershipTransferResult {
  /** The promoted member, now `HouseholdOwner`. */
  readonly owner: HouseholdMemberWithRelations;
  /** The acting member, now `HouseholdAdmin`. */
  readonly previousOwner: HouseholdMemberWithRelations;
}

/**
 * The origins `addMemberWithin` may record. `Founder` is deliberately absent:
 * this seam only admits users to an ALREADY EXISTING household, while founder
 * membership is created by `HouseholdService.create`'s nested write and can
 * never legitimately arrive here. Accepting it would let a later admission be
 * stamped as the household's creation, which is precisely the question the
 * discriminant exists to answer — "how did this person get here" would reply
 * "they founded it" about someone who was invited.
 *
 * Exactly parallel to `HouseholdOwner` being excluded from
 * `AssignableHouseholdRole`: the seam already refuses the ROLE only creation may
 * assign, and this refuses the ORIGIN only creation may assert. The DB enum
 * keeps `Founder`, since the column must still be able to represent it.
 */
export const ADMISSIBLE_MEMBERSHIP_ORIGINS = [
  HouseholdMembershipOrigin.InviteAccepted,
  HouseholdMembershipOrigin.JoinApproved,
] as const;

export type AdmissibleMembershipOrigin = (typeof ADMISSIBLE_MEMBERSHIP_ORIGINS)[number];

export function isAdmissibleMembershipOrigin(origin: HouseholdMembershipOrigin): origin is AdmissibleMembershipOrigin {
  return (ADMISSIBLE_MEMBERSHIP_ORIGINS as readonly HouseholdMembershipOrigin[]).includes(origin);
}

/**
 * Everything `addMemberWithin` needs to admit a user, and nothing it can infer.
 *
 * `origin` and `addedById` are both REQUIRED, unlike the nullable columns they
 * land in. The columns are nullable so rows created outside any consent path
 * (e2e roster fixtures, future imports) can say so honestly; the seam has no
 * such excuse. Making `origin` required is the point of the discriminant — a
 * new caller cannot be written without naming which consent path it represents,
 * and a hypothetical "admin adds a stranger" endpoint has nothing legitimate to
 * pass. Making `addedById` required follows: all three origins have a known
 * actor (founder / inviter / approver), so optionality would only ever let a
 * caller silently drop the provenance the column exists to hold.
 */
export interface AddMemberParams {
  readonly householdId: string;
  readonly userId: string;
  /** Defaults to `HouseholdMember`. `HouseholdOwner` is not assignable here. */
  readonly role?: AssignableHouseholdRole;
  readonly origin: AdmissibleMembershipOrigin;
  /** The acting principal on the household's side; `origin` says in what capacity. */
  readonly addedById: string;
}

/**
 * Outcome of the member-creation seam, plus the caller's post-commit homework.
 *
 * A bare member row would have been enough today and wrong tomorrow: #159 must
 * hand back the soft-overage warnings `QuotaService.consume` collects, and
 * widening the return type later would break every caller and its spec. The
 * shape is fixed now so #159 fills a field instead.
 */
export interface AddMemberResult {
  readonly member: HouseholdMemberWithRelations;
  /**
   * Whether this call wrote the membership. False when the user was a member
   * already, at the pre-read or by a rival admission that landed while this
   * one waited on the quota lock. The row comes back either way; a caller
   * whose act is a join, as an accepted invite is (#163), reads this to tell
   * a join from a no-op rather than re-reading the roster, which would miss
   * the second case.
   */
  readonly admitted: boolean;
  /**
   * Soft caps this admission crossed (#159). The caller MUST forward these to
   * `QuotaService.emitSoftOverages(...)` only AFTER its transaction commits —
   * emitting inside would warn about usage a rollback undoes.
   *
   * Empty when the admission was idempotent: returning an existing member adds
   * nothing to the roster, so it neither consumes nor can overrun a cap.
   */
  readonly softOverages: readonly QuotaSoftOverageEvent[];
}

/**
 * The roster as a role change reads it under the household lock: each row's
 * user and household role, and its id, so the target is found by the row the
 * scoped read returned. A user removed and admitted again while the change
 * waited has a new row, which the change must not write to.
 */
const LOCKED_ROSTER_SELECT = { id: true, ...ROSTER_ROLE_SELECT } as const satisfies Prisma.HouseholdMemberSelect;

/**
 * How a mutation path reports a scoped-resolution miss. Supplied per call site
 * so the denial names the attempted action rather than a generic one.
 */
interface ScopedMemberDenials {
  /**
   * Rows exist but none are visible to this actor → 403 for the attempted
   * action. It may ask more before refusing, as the role change asks whose
   * row it was.
   */
  onHidden: () => never | Promise<never>;
  /** No such row at all → the caller's 404. */
  onMissing: () => never;
}

@Injectable()
export class HouseholdMemberService {
  private readonly logger = new Logger(HouseholdMemberService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly permissions: PermissionsService,
    private readonly events: EventEmitter2,
    private readonly quotas: QuotaService,
    private readonly scopeComposer: ScopeComposer,
    private readonly invites: InviteService,
  ) {}

  /**
   * Paginated member roster: the path household's members, clipped by the
   * actor's `read` ceiling on `HouseholdMember` (membership grant OR
   * friends-reach grant). The read always named its household, so
   * composing the scope (#515) changes no rows; it is what the envelope's guard
   * checks for.
   *
   * A missing or soft-deleted household is a 404. An empty scoped page is
   * resolved by {@link isHiddenFromActor}: rows the actor cannot see mean a
   * permission miss (403); no rows at all — or a page past the end — is an
   * honest empty result (200).
   */
  async getMembers(
    householdId: string,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedRows<HouseholdMemberWithRelations>> {
    await assertHouseholdExists(this.db, householdId);

    const scopedWhere = this.scopeComposer.compose(ResourceType.HouseholdMember, Action.read, { householdId });

    // REPEATABLE READ, so `total` and the rows come from one snapshot (#230):
    // under Prisma's default batch isolation each statement snapshots
    // separately, and a removal landing between them yields rows with a total
    // of zero — which the check below would read as a permission miss.
    //
    // The count is scoped identically to the rows, so it reports what this actor
    // may see, never the household's real roster size.
    //
    // `id` breaks ties on `createdAt`: members added in one transaction share a
    // creation timestamp, so without it a member can shift across a page
    // boundary between two requests.
    const [rows, total] = await this.db.$transaction(
      [
        this.db.householdMember.findMany({
          where: scopedWhere,
          select: MEMBER_SELECT,
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          skip: pagination.skip,
          take: pagination.pageSize,
        }),

        this.db.householdMember.count({ where: scopedWhere }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    // `total` already answers the question {@link isHiddenFromActor} asks first
    // — "are any rows visible to this actor?" — so the list path skips straight
    // to the unscoped probe rather than counting the scoped set twice. A page
    // past the end still has a non-zero total, so it stays an honest 200.
    if (total === 0 && rows.length === 0 && (await this.householdHasHiddenMembers(householdId))) {
      throw new ForbiddenException(t('common.forbidden.view'));
    }

    this.logger.debug(
      `getMembers(${householdId}) → ${rows.length} of ${total} rows (page ${pagination.page}, limit ${pagination.pageSize})`,
    );

    return { rows, total };
  }

  /**
   * Single member by `HouseholdMember.id`, row-scoped like the list. A scoped
   * miss is a hidden row (403) when the row exists unscoped, otherwise a 404.
   */
  async getMember(householdId: string, memberId: string): Promise<HouseholdMemberWithRelations> {
    await assertHouseholdExists(this.db, householdId);

    const scopedWhere = {
      id: memberId,
      householdId,
      // eslint-disable-next-line no-restricted-syntax -- single-row fetch by id, not a collection read
      AND: this.abilityService.getCurrentResourceConditions(ResourceType.HouseholdMember, Action.read),
    } satisfies Prisma.HouseholdMemberWhereInput;

    const member = await this.db.householdMember.findUnique({
      where: scopedWhere,
      select: MEMBER_SELECT,
    });

    if (member) {
      return member;
    }

    if (await this.isHiddenFromActor(scopedWhere, { id: memberId, householdId })) {
      throw new ForbiddenException(t('common.forbidden.view'));
    }

    throw new NotFoundException(t('errors.household.member_not_found', { memberId, householdId }));
  }

  /**
   * Changes a member's household role (#156). Row-scoped by the actor's
   * `manage` conditions on `HouseholdMember`: a household owner's reach every
   * member of the household, and a household admin's only those with the
   * member or guest role (#168).
   *
   * Guards:
   * - The actor cannot change their own role (400). Asked of the row the
   *   scoped read returns, and of a row it misses, so a household admin,
   *   whose own row is outside their manage, hears it too.
   * - A member holding `HouseholdOwner` cannot be changed here at all (400):
   *   every owner transition belongs to transfer-ownership (#158), so no
   *   owner-count reasoning is needed on this path.
   * - The member's role as it stands, and the role the change gives, must
   *   both be ones the actor may manage, asked of the roster read under the
   *   lock (403): a household admin can't make another household admin, nor
   *   change one a household owner made in the meantime (#168).
   *
   * The write is an upsert keyed on the 1:1 `householdMemberId` — the `role`
   * relation is optional on the model, so a role-less member row gets a role
   * created rather than an update miss. Fetch, guards, write, and re-read run
   * in one transaction; the target's ability cache is evicted after commit so
   * the new role's grants resolve on their next request.
   */
  async updateMemberRole(
    householdId: string,
    memberId: string,
    updateMemberRoleDto: UpdateMemberRoleDto,
  ): Promise<HouseholdMemberWithRelations> {
    const actorUserId = this.abilityService.getActingUserId();
    await assertHouseholdExists(this.db, householdId);

    const scopedWhere = {
      id: memberId,
      householdId,
      // eslint-disable-next-line no-restricted-syntax -- single-row role write by id, not a collection read
      AND: this.abilityService.getCurrentResourceConditions(ResourceType.HouseholdMember, Action.manage),
    } satisfies Prisma.HouseholdMemberWhereInput;

    try {
      const updated = await this.db.$transaction(async (tx) => {
        const member = await this.findScopedMemberOrThrow(
          tx,
          scopedWhere,
          { id: memberId, householdId },
          {
            // A household admin's own row is outside their manage (#168), so
            // the scoped read misses it. Asked here, the refusal says why
            // rather than answering 403, and only a miss pays for the
            // question. A membership's user never changes, so no lock is
            // needed for it.
            onHidden: async () => {
              if ((await tx.householdMember.count({ where: { id: memberId, householdId, userId: actorUserId } })) > 0) {
                throw new BadRequestException(t('errors.household.member_role_self'));
              }

              throw new ForbiddenException(t('common.forbidden.update'));
            },
            onMissing: () => {
              throw new NotFoundException(t('errors.household.member_not_found', { memberId, householdId }));
            },
          },
        );

        if (member.userId === actorUserId) {
          throw new BadRequestException(t('errors.household.member_role_self'));
        }

        // Taken AFTER the scoped read, so a 403 or 404 still costs no
        // household-wide lock, and BEFORE the owner check below, which is the
        // decision it protects (#239).
        await lockHouseholdForRoleTransition(tx, householdId);

        // Re-read the member AND its role under the lock rather than trusting
        // the read above, out of the roster the questions below are asked of,
        // so one read under the lock serves both. Two things can have changed
        // while this transaction waited, and both of them are writes this
        // endpoint must not make:
        //
        //  - A concurrent `transferOwnership` promoted this very member. The
        //    pre-lock read saw a plain member, so the upsert below would
        //    overwrite the household's brand-new owner back down to a member and
        //    leave nobody holding the role. Same rule #248 applied to
        //    `deleteMembership` — decide from locked state, never from a
        //    pre-lock read.
        //  - A concurrent removal deleted the member outright. The upsert's
        //    `where` would then match nothing and INSERT, whose FK raises P2003
        //    — which `rethrowMutationFailure` does not classify, so the caller
        //    gets a 500 where 404 is the honest answer. `transferOwnership`
        //    avoids the same hazard by reading its target after the lock.
        const members = await tx.householdMember.findMany({ where: { householdId }, select: LOCKED_ROSTER_SELECT });
        const locked = members.find((row) => row.id === member.id);

        if (!locked) {
          throw new NotFoundException(t('errors.household.member_not_found', { memberId, householdId }));
        }

        if (locked.role?.role.name === SystemRole.HouseholdOwner) {
          throw new BadRequestException(t('errors.household.member_role_owner'));
        }

        // Ask again, of the roster read under the lock, about the member as
        // they stand and as the change leaves them. A household admin manages
        // the member and guest roles alone (#168), so neither may be a
        // household admin: not the role it gives, and not the role it takes
        // away, which a household owner's promotion that landed while this
        // waited would have made it. The scoped read asked only of the state
        // before the lock.
        const mayManageAs = (roleName: string | undefined) =>
          this.abilityService.currentActorCan(Action.manage, ResourceType.HouseholdMember, {
            id: member.id,
            householdId,
            userId: member.userId,
            ...(roleName === undefined ? {} : { role: { role: { name: roleName } } }),
            household: { members },
          });

        if (!mayManageAs(locked.role?.role.name) || !mayManageAs(updateMemberRoleDto.role)) {
          throw new ForbiddenException(t('common.forbidden.update'));
        }

        const roleId = await resolveHouseholdRoleId(tx, updateMemberRoleDto.role);

        await tx.householdRole.upsert({
          where: { householdMemberId: member.id },
          create: { householdMemberId: member.id, roleId },
          update: { roleId },
        });

        return tx.householdMember.findUniqueOrThrow({ where: { id: member.id }, select: MEMBER_SELECT });
      });

      // The target's grants changed — evict their cached ability graph so the
      // new role takes effect immediately rather than after the cache TTL.
      await this.permissions.invalidateUser(updated.userId);

      return updated;
    } catch (error) {
      throw this.rethrowMutationFailure(error, t('common.forbidden.update'), {
        householdId,
        memberId,
        operation: 'updateMemberRole',
      });
    }
  }

  /**
   * Transfers household ownership to another member (#158): the target becomes
   * `HouseholdOwner`, the acting owner becomes `HouseholdAdmin`, atomically.
   * This is the ONLY path that produces an owner transition in either
   * direction — #156's change-role endpoint refuses owner targets and cannot
   * assign `HouseholdOwner`, so a household can never reach a multiple-owner or
   * ownerless state through a surface that reasons about one row at a time.
   *
   * Authorization is the Owner-only `update:household_role:transfer-ownership`
   * gate at the controller. Row scoping uses the actor's `manage` conditions on
   * `HouseholdMember`. A household admin's own copy of those reaches people
   * with the member or guest role (#168), so scoping alone does not restrict
   * this endpoint — the gate does, and the locked owner set backs it inside
   * the transaction.
   *
   * Multiple owners are representable (`HouseholdRole` is 1:1 per *member*, but
   * N members may hold `HouseholdOwner`), so this is a swap and not a
   * normalization: co-owners are untouched, and a co-owner may transfer.
   */
  async transferOwnership(householdId: string, memberId: string): Promise<OwnershipTransferResult> {
    const initiatedAt = new Date();
    const actorUserId = this.abilityService.getActingUserId();
    await assertHouseholdExists(this.db, householdId);

    // Preflight, outside the transaction. The controller gate
    // (`can(update, HouseholdRole)`) is a class-level check: it asserts the actor
    // owns SOME household, not this one. Without this, an owner of household A
    // could call the route for household B and take B's owner-row lock before
    // the in-transaction read refused them, letting any authenticated owner
    // contend on the owner rows of any household id they can name.
    //
    // Best-effort filter, NOT the authorization boundary — an unlocked read
    // cannot be one. The authoritative checks stay inside the transaction, where
    // the scoped read decides hidden vs absent and the locked owner set decides
    // authority. Do not remove those on the strength of this.
    const actorMemberships = await this.db.householdMember.count({ where: { householdId, userId: actorUserId } });

    if (!actorMemberships) {
      throw new NotFoundException(t('errors.household.not_a_member', { householdId }));
    }

    // Resolved OUTSIDE the transaction. Role ids are static seed data, not
    // household state, so holding the owner-row lock across two lookups that
    // cannot change the outcome only extends the window in which concurrent
    // departures block. A seed change mid-flight would fail the FK regardless.
    const ownerRoleId = await resolveHouseholdRoleId(this.db, SystemRole.HouseholdOwner);
    const adminRoleId = await resolveHouseholdRoleId(this.db, SystemRole.HouseholdAdmin);

    // eslint-disable-next-line no-restricted-syntax -- clips the two rows a transfer writes, not a collection read
    const conditions = this.abilityService.getCurrentResourceConditions(ResourceType.HouseholdMember, Action.manage);
    const actorWhere = {
      householdId,
      userId: actorUserId,
      AND: conditions,
    } satisfies Prisma.HouseholdMemberWhereInput;
    const targetWhere = { id: memberId, householdId, AND: conditions } satisfies Prisma.HouseholdMemberWhereInput;

    try {
      const { before, after, result } = await this.db.$transaction(async (tx) => {
        // Lock FIRST, read second. Two invariants depend on it:
        //
        // 1. Two co-owners transferring concurrently would each read the other
        //    as an owner, each demote itself, and leave the household ownerless
        //    — a legitimate-looking swap from inside either transaction.
        // 2. `deleteMembership` takes this same lock, so serializing here is
        //    what stops a concurrent removal of the target from landing between
        //    the read and the upsert. That ordering would insert a HouseholdRole
        //    for a deleted member and raise P2003, which
        //    `rethrowMutationFailure` does not classify — an uncaught 500 where
        //    the honest answer is 404.
        //
        // Reading after the lock is also what collapses the guards: there is no
        // longer a pre-lock check to repeat, because every fact below is read
        // from locked state.
        //
        // The household row comes FIRST, and it is what actually serializes two
        // role transitions — the owner-row lock cannot, because the set it
        // covers is defined by the very column a transfer rewrites (#239; see
        // `lockHouseholdForRoleTransition`). Consistent ordering everywhere:
        // household row, then owner rows.
        await lockHouseholdForRoleTransition(tx, householdId);
        const ownerMemberIds = await this.lockHouseholdOwnerRows(tx, householdId);

        // Authorization strictly before validation: resolving the actor first
        // means a caller who is not an owner is refused before any 400 can
        // answer "is member X already the owner?" on their behalf.
        const actor = await this.findScopedMemberOrThrow(
          tx,
          actorWhere,
          { householdId, userId: actorUserId },
          {
            onHidden: () => {
              throw new ForbiddenException(t('common.forbidden.update'));
            },
            onMissing: () => {
              throw new NotFoundException(t('errors.household.not_a_member', { householdId }));
            },
          },
        );

        if (!ownerMemberIds.includes(actor.id)) {
          throw new ForbiddenException(t('common.forbidden.update'));
        }

        const target = await this.findScopedMemberOrThrow(
          tx,
          targetWhere,
          { id: memberId, householdId },
          {
            onHidden: () => {
              throw new ForbiddenException(t('common.forbidden.update'));
            },
            onMissing: () => {
              throw new NotFoundException(t('errors.household.member_not_found', { memberId, householdId }));
            },
          },
        );

        if (target.id === actor.id) {
          throw new BadRequestException(t('errors.household.transfer_target_self'));
        }

        if (ownerMemberIds.includes(target.id)) {
          throw new BadRequestException(t('errors.household.transfer_target_already_owner', { memberId }));
        }

        // Upserts, not updates: `role` is optional on HouseholdMember, so a
        // role-less target must get a row created rather than produce a miss.
        //
        // Deliberately NOT carrying the ability conditions in these `where`
        // clauses, unlike the scoped deletes in `deleteMembership`. An upsert
        // whose `where` matches nothing INSERTS — an authorization miss would
        // become a duplicate-key error (or, on a model without the unique
        // constraint, a silently created row), not the P2025 → 403 the delete
        // paths rely on. Write-time authorization here is the lock above: the
        // owner rows this actor's authority derives from are held for the rest
        // of the transaction, so a concurrent demotion cannot interleave.
        await tx.householdRole.upsert({
          where: { householdMemberId: target.id },
          create: { householdMemberId: target.id, roleId: ownerRoleId },
          update: { roleId: ownerRoleId },
        });

        await tx.householdRole.upsert({
          where: { householdMemberId: actor.id },
          create: { householdMemberId: actor.id, roleId: adminRoleId },
          update: { roleId: adminRoleId },
        });

        const owner = await tx.householdMember.findUniqueOrThrow({
          where: { id: target.id },
          select: MEMBER_SELECT,
        });
        const previousOwner = await tx.householdMember.findUniqueOrThrow({
          where: { id: actor.id },
          select: MEMBER_SELECT,
        });

        return {
          before: { householdId, ownerMemberId: actor.id, ownerUserId: actor.userId },
          after: { householdId, ownerMemberId: target.id, ownerUserId: target.userId },
          result: { owner, previousOwner },
        } satisfies {
          before: HouseholdOwnershipSnapshot;
          after: HouseholdOwnershipSnapshot;
          result: OwnershipTransferResult;
        };
      });

      // Both parties' grants changed, so both graphs are evicted — one bulk
      // call rather than two, since `invalidateUsers` de-dupes and bounds
      // concurrency.
      await this.permissions.invalidateUsers([before.ownerUserId, after.ownerUserId]);
      this.emitOwnershipTransferred(before, after, initiatedAt);

      return result;
    } catch (error) {
      throw this.rethrowMutationFailure(error, t('common.forbidden.update'), {
        householdId,
        memberId,
        operation: 'transferOwnership',
      });
    }
  }

  /**
   * Admits a user to an existing household inside the CALLER'S transaction
   * (#276): inserts the `HouseholdMember` row and its 1:1 `HouseholdRole`, and
   * returns the row in the `MEMBER_SELECT` shape so the caller needs no second
   * fetch.
   *
   * This is an internal seam, not an endpoint, and there is deliberately no
   * `POST /households/:householdId/members` behind it. Household membership is
   * a bidirectional data grant — members read each other's game collections —
   * so it is a trust boundary rather than a placement within one, and crossing
   * it requires the JOINING USER's affirmative act.
   *
   * Three paths satisfy that system-wide, but only TWO of them come through
   * here: invite accepted (#163) and join request approved (#231). The founder's
   * own membership is written by `HouseholdService.create` and is refused here —
   * see {@link ADMISSIBLE_MEMBERSHIP_ORIGINS}. `params.origin` records which of
   * the two applies, and is required rather than inferred so that a new caller
   * cannot be written without naming its consent path.
   *
   * ## The `tx` is load-bearing — do not hand this `this.db`
   *
   * Typed `Prisma.TransactionClient` exactly, not the `LockFreeReadClient`
   * union the role lookup takes, and for the same reason `QuotaService.consume` is:
   * the guarantees here are row locks, and they only hold for the life of a
   * transaction. A base client would compile, pass its tests, and serialize
   * nothing.
   *
   * ## What the caller still owes, after commit
   *
   * Nothing below is done here, because none of it can be undone by a rollback:
   *
   * - `PermissionsService.invalidateUser(userId)` — the new member's cached
   *   ability graph must be evicted or their household grants wait out the
   *   5-minute TTL. Invalidating inside the transaction would evict a graph for
   *   a membership that may still roll back, and the resulting stale-grant
   *   window would be invisible.
   * - `QuotaService.emitSoftOverages(result.softOverages)` — see
   *   {@link AddMemberResult}.
   * - Domain events / audit (#245) — the household aggregate emits nothing for
   *   member-added yet.
   *
   * ## Idempotency
   *
   * An already-present membership is RETURNED, not rejected, so the caller
   * decides what a join that joined nobody means. The invite accept (#163)
   * answers 409 and rolls back, leaving the invite outstanding. A replayed
   * accept never gets here: the invites lib refuses the settled invite first.
   * The pre-read is what delivers the return — catching the P2002 could not,
   * because Postgres aborts the transaction on a constraint violation and
   * Prisma opens no savepoint, so the recovering re-read would itself fail. A
   * genuine concurrent double-admit therefore surfaces as 409, and a caller that
   * retries the whole transaction meets the pre-read on the second attempt.
   *
   * Returned is not the same as admitted; {@link AddMemberResult.admitted}
   * says which.
   *
   * The same race is also absorbed on the quota path: a denial is only reported
   * as a cap breach once a re-read confirms the membership is still absent, since
   * waiting on the quota lock is exactly when a rival admission can commit.
   *
   * A pre-existing member whose role differs from `params.role` is returned
   * UNCHANGED. Silently applying the requested role would make any invite link
   * a privilege-escalation path; role changes are {@link updateMemberRole}.
   *
   * ## Quota (#159)
   *
   * `household_member_count` is consumed AFTER the idempotency pre-read and
   * BEFORE the insert. Both halves of that are load-bearing: an idempotent
   * return adds no one to the roster, so charging it would let a client walk a
   * household past its cap by replaying one accept, and consuming after the
   * insert would take the advisory lock too late to serialize anything.
   *
   * The founder is never CHARGED — `HouseholdService.create` does not route
   * through this seam, so creating a household is never gated by the cap — but
   * the founder row is COUNTED. `countHouseholdMembers` counts every row in the
   * household and deliberately does not filter on `origin`: that column is
   * nullable, so a filtered count would silently under-report exactly the rows
   * whose provenance is unknown, and a cap must not depend on a nullable audit
   * column. A cap of N is therefore a roster cap of N with the founder inside
   * it, and a cap of 1 yields a solo household.
   */
  async addMemberWithin(tx: Prisma.TransactionClient, params: AddMemberParams): Promise<AddMemberResult> {
    const { householdId, userId, origin, addedById } = params;
    const role = params.role ?? SystemRole.HouseholdMember;

    // Runtime guard as well as the compile-time one. `AssignableHouseholdRole`
    // stops an in-process caller passing `HouseholdOwner`, but the roles that
    // reach this seam are not all statically known — an invite carries a `Role`
    // FK, so #163 reads back the role's name as a plain string — and a cast
    // would sail past the type. Admitting an owner here would let a second owner appear without
    // going through transfer-ownership's locking (#158).
    if (!isAssignableHouseholdRole(role)) {
      throw new BadRequestException(t('errors.household.member_role_not_assignable', { role }));
    }

    // Server error, not a 400, unlike the role guard above. A role can arrive
    // from data — #163 resolves one from an `Invite.roleId` — so a bad role is
    // plausibly a caller's problem. `origin` is never client-derived: every call
    // site passes a literal naming its own consent path, so `Founder` reaching
    // here means the code is miswired, and reporting 400 would blame the caller
    // for our mistake. Same reasoning as `role_not_provisioned` for seed drift.
    if (!isAdmissibleMembershipOrigin(origin)) {
      throw new InternalServerErrorException(t('errors.household.member_origin_not_admissible', { origin }));
    }

    // Locks the household row for the rest of the transaction, so a concurrent
    // soft-delete (#154) cannot land between this check and the insert.
    await lockExistingHousehold(tx, householdId);

    const existing = await this.findMembershipWithin(tx, householdId, userId);

    if (existing) {
      this.logger.debug(`addMemberWithin(${householdId}, ${userId}) → already a member, returning existing row`);

      return { member: existing, admitted: false, softOverages: [] };
    }

    const roleId = await resolveHouseholdRoleId(tx, role);

    // Takes `pg_advisory_xact_lock` on the caller's transaction, so concurrent
    // admissions to the same household serialize on the cap rather than both
    // reading the pre-image and both passing.
    //
    // `QuotaCheckContext.userId` is the ACTING principal — it is what the `User`
    // scope resolves against — and neither of this method's parameters is that.
    // The joining user is the subject, not the actor. `addedById` is the actor
    // only for `JoinApproved`, where the approver drives the request; for
    // `InviteAccepted` the actor is the invitee and `addedById` is the inviter,
    // who is not present at all. The seam cannot derive it, so it reads the same
    // CLS actor context every other mutation on this service reads. Inert while
    // the resource is Household-scoped only, and wrong the moment it is not.
    const decision = await this.quotas.consume(
      'household_member_count',
      1n,
      { userId: this.abilityService.getActingUserId(), householdId },
      tx,
    );

    if (!decision.allowed) {
      // A denial here does NOT necessarily mean the household is full.
      //
      // `consume` blocks on `pg_advisory_xact_lock`, so a concurrent admission of
      // THIS SAME user can commit while we wait. The usage we are then measured
      // against already includes the row we were about to insert, and a cap that
      // was exactly binding tips over. Throwing here would report "cap exceeded"
      // for a membership that now exists — a wrong answer rather than merely a
      // wrong status, since the membership the caller asked for exists. For
      // #163 that would tell an invitee the household is full when they are in
      // it; returned with `admitted: false`, the accept answers that they are a
      // member already.
      //
      // Re-reading is safe here in a way it is not in the P2002 branch below:
      // `consume` returned a value rather than raising, so the transaction is
      // healthy, and under READ COMMITTED this statement takes a fresh snapshot
      // that includes the winner's commit. The advisory lock is ours until commit,
      // so nothing can change underneath the re-read either.
      const admittedConcurrently = await this.findMembershipWithin(tx, householdId, userId);

      if (admittedConcurrently) {
        this.logger.debug(
          `addMemberWithin(${householdId}, ${userId}) → admitted concurrently while awaiting the quota lock`,
        );

        return { member: admittedConcurrently, admitted: false, softOverages: [] };
      }

      throw new QuotaExceededException(
        // eslint-disable-next-line no-restricted-syntax -- quota metric key, not user copy; QuotaExceededException localizes its message in @bge/quota
        'household_member_count',
        decision.scope!,
        decision.limit!,
        decision.currentUsage!,
        1n,
      );
    }

    try {
      const member = await tx.householdMember.create({
        data: {
          householdId,
          userId,
          origin,
          addedById,
          role: { create: { roleId } },
        },
        select: MEMBER_SELECT,
      });

      return { member, admitted: true, softOverages: decision.softOverages };
    } catch (error) {
      // Only the membership unique means "already a member". The nested
      // member/role create can raise P2002 from either generated primary key
      // today and from whatever unique someone adds tomorrow, and translating
      // those to 409 would hide an unrelated database failure behind a
      // confidently wrong answer.
      //
      // Unlike `HouseholdService.recoverKeyedCreate` and
      // `FeedbackService.recoverKeyedSubmit`, this cannot decide by re-reading the
      // row: Postgres has already aborted the transaction and Prisma opens no
      // savepoint, so a lookup here would itself fail. The error payload is the
      // only remaining source of truth (#298).
      if (isPrismaUniqueConstraintError(error)) {
        const identity = constraintIdentity(error);

        if (this.isDuplicateMembership(identity)) {
          // Lost the race against a concurrent admission of the same user. 409;
          // a caller that retries the whole transaction meets the pre-read.
          this.logger.debug(`Concurrent admission of user ${userId} to household ${householdId}`);

          throw new ConflictException(t('errors.household.already_a_member', { householdId }));
        }

        // Narrowed on the discriminant rather than via `isIdentifiedConstraint`,
        // because `not-a-unique-violation` is also "not identified" and carries no
        // `sqlState` to report. It is unreachable here — we are inside the P2002
        // gate — but reading a field off a state that cannot occur is how the
        // impossible becomes the unnoticed.
        if (identity.source === 'unknown') {
          // COULD NOT TELL which constraint fired, which is not the same as
          // knowing it was a different one. Answering 409 here is not a guess:
          // `household_members` carries exactly one unique besides its primary
          // key, `household_roles`' two uniques both key on a `householdMemberId`
          // this statement generates fresh, and a cuid2 primary-key collision is
          // negligible — so the membership unique is the only violation reachable
          // from this insert. `p2002-shape.spec.ts` guards that enumeration; if a
          // second unique is added to the table, it fails and this branch has to
          // be revisited.
          //
          // Warn rather than debug: reaching this means the payload stopped
          // carrying an identity, and finding that out from a log beats finding it
          // out from a wrong status code.
          //
          // ONE KNOWN WAY TO REACH THIS PERMANENTLY, and it is a privilege
          // question rather than a Prisma-version one. `constraint.fields` is
          // parsed from Postgres's DETAIL line, and `BuildIndexValueDescription`
          // omits DETAIL entirely when the connecting role lacks SELECT on the key
          // columns. Deploy the API under a write-scoped role that is not the
          // schema owner and EVERY P2002 here degrades to `unknown`.
          //
          // Correctness survives that — the enumeration above is about which
          // uniques exist, not about the payload — but observability does not:
          // this warn stops being an anomaly signal and becomes one line per
          // concurrent admission. Nothing currently provisions such a role (no
          // GRANT or CREATE ROLE in `prisma/`, and the e2e harness connects as the
          // owner, so `p2002-shape.spec.ts` would stay green through the change).
          // If a scoped role is ever introduced, revisit this branch before the
          // logs are trusted.
          this.logger.warn(
            `Could not identify the unique behind a member-insert P2002; assuming a concurrent admission of ` +
              `user ${userId} to household ${householdId}. sqlState=${identity.sqlState ?? 'unreported'} ` +
              `meta=${JSON.stringify(error.meta)}`,
          );

          throw new ConflictException(t('errors.household.already_a_member', { householdId }));
        }

        // Identified, and it is something else. Record the whole payload rather
        // than degrading silently — logging only `meta.target` is what made the
        // original failure invisible, since that field does not exist here.
        if (isIdentifiedConstraint(identity)) {
          this.logger.error(
            `Member insert hit an unexpected unique; source=${identity.source} ` +
              `names=${JSON.stringify(identity.names)} meta=${JSON.stringify(error.meta)}`,
            error,
          );
        }
      }

      throw error;
    }
  }

  /**
   * True only when a P2002's constraint identity names the
   * `(householdId, userId)` unique.
   *
   * Every known SPELLING of that one constraint is accepted, because the spelling
   * depends on which source the identity came from: raw columns from the driver
   * adapter (what ships today), Prisma field names from a restored `meta.target`,
   * the mapped index name on MySQL. Each is compared as an unordered EXACT set,
   * so this is not a return to the accept-list this replaced — a superset such as
   * a future `@@unique([householdId, userId, ...])` is correctly refused rather
   * than mistaken for this constraint.
   *
   * Takes the identity rather than the error so the caller can distinguish "not
   * this constraint" from "no identity at all" and answer them differently.
   */
  private isDuplicateMembership(identity: ConstraintIdentity): boolean {
    return identifiesConstraint(identity, HOUSEHOLD_MEMBER_UNIQUE_COLUMNS, HOUSEHOLD_MEMBER_UNIQUE_FIELDS, [
      HOUSEHOLD_MEMBER_UNIQUE_CONSTRAINT,
    ]);
  }

  /**
   * The membership lookup `addMemberWithin` performs twice: once as its
   * idempotency pre-read, once to tell a genuine cap breach from a rival
   * admission that landed while it waited on the quota lock. Shared so the two
   * cannot drift into asking different questions.
   */
  private findMembershipWithin(
    tx: Prisma.TransactionClient,
    householdId: string,
    userId: string,
  ): Promise<HouseholdMemberWithRelations | null> {
    return tx.householdMember.findUnique({
      where: { householdId_userId: { householdId, userId } },
      select: MEMBER_SELECT,
    });
  }

  /**
   * Removes another member (#157). Row-scoped by the actor's `manage`
   * conditions on `HouseholdMember`: a household owner's reach every member of
   * the household, co-owners included, and a household admin's only those with
   * the member or guest role, since only a household owner acts on the
   * household admin role (#168). So a household owner removing their own row
   * is allowed — it is semantically identical to leaving, and the last-owner
   * guard applies either way — while a household admin leaves through `DELETE
   * …/members/me`, which the leave grant covers.
   */
  async removeMember(householdId: string, memberId: string): Promise<HouseholdMemberWithRelations> {
    await assertHouseholdExists(this.db, householdId);

    const scopedWhere = {
      id: memberId,
      householdId,
      // eslint-disable-next-line no-restricted-syntax -- single-row delete by id, not a collection read
      AND: this.abilityService.getCurrentResourceConditions(ResourceType.HouseholdMember, Action.manage),
    } satisfies Prisma.HouseholdMemberWhereInput;

    return this.deleteMembership(
      scopedWhere,
      { id: memberId, householdId },
      {
        onHidden: () => {
          throw new ForbiddenException(t('common.forbidden.delete'));
        },
        onMissing: () => {
          throw new NotFoundException(t('errors.household.member_not_found', { memberId, householdId }));
        },
      },
    );
  }

  /**
   * The acting user leaves the household (#157). Row-scoped by the actor's
   * `delete` conditions on `HouseholdMember` (`delete:household_member:leave`)
   * — and additionally pinned to `userId` explicitly: CASL's `manage` implies
   * every action, so a household owner's `delete` conditions cover every
   * member of their household, and a household admin's every one with the
   * member or guest role (#168). Without the pin this endpoint would delete
   * whichever row the conditions happened to match. The pin makes "me" mean me
   * by construction, independent of how broad the actor's grants are.
   */
  async leaveHousehold(householdId: string): Promise<HouseholdMemberWithRelations> {
    const actorUserId = this.abilityService.getActingUserId();
    await assertHouseholdExists(this.db, householdId);

    const scopedWhere = {
      householdId,
      userId: actorUserId,
      // eslint-disable-next-line no-restricted-syntax -- the actor's own membership row, not a collection read
      AND: this.abilityService.getCurrentResourceConditions(ResourceType.HouseholdMember, Action.delete),
    } satisfies Prisma.HouseholdMemberWhereInput;

    return this.deleteMembership(
      scopedWhere,
      { householdId, userId: actorUserId },
      {
        onHidden: () => {
          throw new ForbiddenException(t('common.forbidden.delete'));
        },
        onMissing: () => {
          throw new NotFoundException(t('errors.household.not_a_member', { householdId }));
        },
      },
    );
  }

  /**
   * Shared removal primitive for remove-member and leave-household: resolve
   * the target under the caller's scoped `where`, enforce the last-owner
   * invariant, then delete the membership and its dependents in one
   * transaction, evicting the removed user's ability cache after commit.
   *
   * Deletion order is mandatory — the schema declares no cascades, so
   * `ExcludedGame` and the 1:1 `HouseholdRole` must go before the
   * `HouseholdMember` row. The scoped `where` is asked again under the lock,
   * before the first delete, so authorization is decided from locked state as
   * well as at read time (403).
   *
   * Leaving and being removed end the same invites (#747), in the same
   * transaction: those the member sent, whose authority ended with the
   * membership, and those that name them by id, which would let them back
   * in. Invites to their address stay open, since revoking those would tell
   * each inviter whose address it was. The household row is locked first, the
   * lock order the invites lib asks for. The revoked invites are announced
   * after the cache eviction.
   *
   * Leaving and being removed also end the member's game shares into the
   * household (#810): the shares of the games they created, which they
   * shared on the standing the membership gave them. Their shares into other
   * households stay. Each ended share is announced after the revoked invites.
   */
  private async deleteMembership(
    scopedWhere: Prisma.HouseholdMemberWhereInput & { householdId: string },
    unscopedWhere: Prisma.HouseholdMemberWhereInput,
    denials: ScopedMemberDenials,
  ): Promise<HouseholdMemberWithRelations> {
    try {
      const initiatedAt = new Date();
      const { removed, revoked, endedShares } = await this.db.$transaction(async (tx) => {
        const member = await this.findScopedMemberOrThrow(tx, scopedWhere, unscopedWhere, denials);

        // Lock unconditionally, and decide from the LOCKED set — never from
        // `member.role`, which is a pre-lock read.
        //
        // Gating the lock on that read was sound only while nothing could
        // promote a member to owner concurrently. #158 ships exactly that path:
        // a member promoted by `transferOwnership` between this read and its
        // commit would have been deleted with the last-owner check skipped
        // entirely, leaving the household ownerless and unadministrable with no
        // error raised anywhere.
        //
        // Reading before locking is safe because the decision uses only
        // `member.id`, which is immutable, plus the locked owner set. Whichever
        // way this interleaves with a concurrent transfer, one of the two blocks
        // on the other's lock and observes its committed result. It also keeps
        // 404/403 requests from taking a household-wide lock, which locking
        // first would have done.
        //
        // The cost is that concurrent departures within one household serialize
        // on it. That is the price of correctness under READ COMMITTED: there is
        // no way to know whether the lock is needed without first taking it.
        // Households are small and departures are rare.
        //
        // The household row is what does the serializing (#239). Taking only
        // the owner rows left this path's worst case open: a transfer that
        // promotes the departing member commits while this transaction waits,
        // and the re-checked owner set comes back EMPTY — the old owner dropped
        // out of it, the new owner was never in it — so the guard below sees no
        // owners at all and deletes the household's only one.
        await lockHouseholdForRoleTransition(tx, scopedWhere.householdId);
        const ownerMemberIds = await this.lockHouseholdOwnerRows(tx, scopedWhere.householdId);

        // Re-applies the scoped `where` under the lock, so a permission change
        // that landed between the read and the lock still surfaces as 403. It
        // comes before the last-owner check, authorization before validation,
        // so a caller the locked state refuses learns nothing of the
        // household's owners. And it comes BEFORE the dependents go: a grant
        // that reads the member's household role, as a household admin's does
        // (#168), matches nothing once the role row is deleted. The lock keeps
        // the answer standing through the deletes, since every role transition
        // and every removal in this household takes it too.
        const reachable = await tx.householdMember.findFirst({
          where: { ...scopedWhere, id: member.id },
          select: { id: true },
        });

        if (!reachable) {
          await denials.onHidden();
        }

        if (ownerMemberIds.includes(member.id) && ownerMemberIds.length <= 1) {
          throw new BadRequestException(t('errors.household.last_owner', { householdId: scopedWhere.householdId }));
        }

        await tx.excludedGame.deleteMany({ where: { householdMemberId: member.id } });
        // The shares into this household of the games the member created end
        // with the membership (#810), as the invites they sent do (#747): the
        // standing to share into the household was the membership's. Keyed on
        // the game's owner, not `sharedById`, which `SetNull` empties when the
        // sharer's account is deleted and would leave that share standing. Only
        // a game's owner shares it, so these are all the member's shares, those
        // waiting for approval too. Shares into the member's other households
        // are those households' to keep.
        const endedShares = await this.endGameSharesWithin(tx, scopedWhere.householdId, member.userId);
        // deleteMany: the 1:1 role relation is optional, so a role-less member
        // must not turn the cleanup into a P2025.
        await tx.householdRole.deleteMany({ where: { householdMemberId: member.id } });

        await tx.householdMember.delete({ where: { id: member.id } });

        const { events } = await this.invites.revokeOutstandingOfUserWithin(
          tx,
          { householdId: scopedWhere.householdId },
          member.userId,
        );

        return { removed: member, revoked: events, endedShares };
      });

      // The household just left this user's ability surface — evict their
      // cached graph so stale Household* abilities don't linger for the TTL.
      await this.permissions.invalidateUser(removed.userId);
      this.invites.emit(revoked);
      this.emitGameSharesEnded(endedShares, initiatedAt);

      return removed;
    } catch (error) {
      throw this.rethrowMutationFailure(error, t('common.forbidden.delete'), {
        ...unscopedWhere,
        operation: 'deleteMembership',
      });
    }
  }

  /**
   * Deletes the shares into this household of the games `userId` created
   * (#810), and hands back each one this transaction deleted, for its event.
   *
   * One guarded delete per share read, rather than one `deleteMany`: Prisma's
   * `deleteMany` returns no rows, and the sharer's own delete takes no
   * household lock (`GameShareService.delete`), so a share read here may be
   * gone by its delete. A share whose delete counts nothing was removed and
   * announced by the sharer, and is not announced again. A member's shares
   * into one household are few, so the per-row statements cost little.
   */
  private async endGameSharesWithin(
    tx: Prisma.TransactionClient,
    householdId: string,
    userId: string,
  ): Promise<GameShare[]> {
    const shares = await tx.gameShare.findMany({ where: { householdId, game: { is: { createdById: userId } } } });
    const ended: GameShare[] = [];

    for (const share of shares) {
      const { count } = await tx.gameShare.deleteMany({ where: { id: share.id } });

      if (count > 0) {
        ended.push(share);
      }
    }

    return ended;
  }

  /**
   * Announces the game shares a departure ended, one event each. The departure
   * is committed by then, so a listener's throw is logged rather than answered
   * as a 500, for the reason `emitOwnershipTransferred` gives.
   */
  private emitGameSharesEnded(shares: readonly GameShare[], initiatedAt: Date): void {
    for (const share of shares) {
      try {
        this.events.emit(
          HouseholdGameShareEndedEvent.eventName,
          new HouseholdGameShareEndedEvent(gameShareSnapshot(share), initiatedAt),
        );
      } catch (error) {
        this.logger.error('Departure committed but a game share emission failed', { error, shareId: share.id });
      }
    }
  }

  /**
   * Single failure classifier for the three mutations. Three outcomes, and the
   * log level is the point:
   *
   * - An `HttpException` raised inside the transaction is a business-rule
   *   rejection the endpoint is specified to produce (own role, owner role,
   *   last owner, hidden row, not found). Rethrown untouched and NOT logged at
   *   error level — client-driven 4xx on a normal endpoint would otherwise be
   *   indistinguishable from real defects in log-based alerting.
   * - A `P2025` is the scoped write missing: the rows this actor was permitted
   *   to touch no longer match. Expected under concurrency, so `debug`.
   * - Anything else is unexpected and keeps the full `error` log.
   */
  private rethrowMutationFailure(
    error: unknown,
    forbiddenMessage: ReturnType<typeof t>,
    context: Record<string, unknown>,
  ): never {
    if (error instanceof HttpException) {
      throw error;
    }

    if (isPrismaDependentRecordNotFoundError(error)) {
      this.logger.debug(`Scoped write matched no rows: ${JSON.stringify(context)}`);
      throw new ForbiddenException(forbiddenMessage);
    }

    this.logger.error(`Unexpected failure: ${JSON.stringify(context)}`, error);
    throw error;
  }

  /**
   * Locks the household's `HouseholdOwner` role rows for the remainder of the
   * transaction and returns the `HouseholdMember.id`s holding them.
   *
   * The lock, not the count, is the point. Under READ COMMITTED two concurrent
   * owner transitions each read the pre-image and each conclude they are safe.
   *
   * `FOR UPDATE OF hr` is HALF of the answer, and on its own it is the wrong
   * half: the rows it covers are selected by `roles.name`, the column a
   * transfer rewrites, so a blocked statement re-checks the demoted owner out
   * of its result and never sees the promoted one (#239). Mutual exclusion
   * comes from {@link lockHouseholdForRoleTransition}, which every caller takes
   * first; this statement pins the rows this transaction is about to act on and
   * returns them. Both callers need the set, for different invariants:
   *
   * - {@link deleteMembership} — a household must keep at least one owner.
   * - {@link transferOwnership} — the acting owner must still be an owner, and
   *   the target must still not be, at the moment the writes are issued.
   *
   * Returning the set rather than asserting inside is what lets both share one
   * lock: the assertion differs, the locking does not.
   *
   * NOTE: the raw SQL is never executed by the unit suite ($queryRaw is
   * mocked). Its identifiers are pinned against the checked-in Prisma models by
   * a spec in this lib, which catches a later `@map` rename; what it does
   * against a real database — including the re-check behaviour described above
   * — is pinned by `apps/api-e2e/src/household` (#239).
   */
  private async lockHouseholdOwnerRows(tx: Prisma.TransactionClient, householdId: string): Promise<string[]> {
    const owners = await tx.$queryRaw<Array<{ household_member_id: string }>>(Prisma.sql`
      SELECT hr.household_member_id
      FROM household_roles hr
      JOIN household_members hm ON hm.id = hr.household_member_id
      JOIN roles r ON r.id = hr.role_id
      WHERE hm.household_id = ${householdId}
        AND r.name = ${SystemRole.HouseholdOwner}
      FOR UPDATE OF hr
    `);

    return owners.map((owner) => owner.household_member_id);
  }

  /**
   * Fans the completed transfer out to the two emit-driven subsystems: the
   * `MutationEvent` (audit row, via `AuditPersistenceListener`'s `onAny`) and
   * the versioned webhook wire name. Two separate emits from one call site,
   * mirroring the game-import processors.
   *
   * Called AFTER commit — a webhook or audit failure must never roll back the
   * transfer, and a delivery describing a transaction that later aborted would
   * be worse than a missing one.
   *
   * No `occurrenceId`: the envelope wants an id that is stable across re-emits
   * of the SAME occurrence, and nothing available here qualifies. The audit row
   * id does not exist yet (the listener writes it after this returns), and every
   * id that does exist — the household, either role row — is stable across
   * *different* transfers, so using one would make a second, legitimate
   * transfer dedup against the first and silently drop its delivery. Absent an
   * occurrenceId the dispatcher assigns a random delivery id (no dedup), which
   * the contract explicitly allows.
   */
  private emitOwnershipTransferred(
    before: HouseholdOwnershipSnapshot,
    after: HouseholdOwnershipSnapshot,
    initiatedAt: Date,
  ): void {
    try {
      this.emitTransferEvents(before, after, initiatedAt);
    } catch (error) {
      // The transfer is COMMITTED and both ability caches are already evicted.
      // `EventEmitter2` is configured without `ignoreErrors`, so a synchronous
      // listener that throws propagates out of `emit()` — and this call sits
      // inside the mutation's try block, so it would reach
      // `rethrowMutationFailure`, be classified as unexpected, and surface as a
      // 500 for an operation that succeeded. The client would then retry into a
      // 400 "already an owner".
      //
      // Logged rather than swallowed: a missing audit row is a real problem,
      // just not one the caller can act on or retry away. Making audit writes
      // durable rather than best-effort is #245's concern.
      this.logger.error('Ownership transfer committed but emission failed', {
        error,
        householdId: after.householdId,
        previousOwnerMemberId: before.ownerMemberId,
        newOwnerMemberId: after.ownerMemberId,
      });
    }
  }

  private emitTransferEvents(
    before: HouseholdOwnershipSnapshot,
    after: HouseholdOwnershipSnapshot,
    initiatedAt: Date,
  ): void {
    this.events.emit(
      HouseholdOwnershipTransferredEvent.eventName,
      new HouseholdOwnershipTransferredEvent(before, after, initiatedAt),
    );

    this.events.emit(
      WebhookEventType.HouseholdOwnershipTransferred,
      webhookEnvelope({
        subjectId: after.householdId,
        householdId: after.householdId,
        // Ids only. `data` is copied verbatim to a subscriber-controlled URL, so
        // usernames, display names, avatars, and emails stay out of it — a read
        // grant on the household is not consent to ship member identity to a
        // third party.
        data: {
          householdId: after.householdId,
          previousOwnerMemberId: before.ownerMemberId,
          previousOwnerUserId: before.ownerUserId,
          newOwnerMemberId: after.ownerMemberId,
          newOwnerUserId: after.ownerUserId,
        },
      }),
    );
  }

  /**
   * Resolves a member under a permission-scoped `where`, disambiguating a
   * scoped miss into a hidden row or an absent one — the mutation-path
   * counterpart of {@link isHiddenFromActor}, running against the transaction
   * client so the resolution participates in the caller's transaction.
   *
   * Both outcomes are delegated to the caller rather than thrown here: the
   * denial has to name the action the actor actually attempted. A member
   * hidden from a `removeMember` call is a delete denial, not a view denial,
   * and reporting "you don't have permission to view this resource" for a
   * DELETE misdescribes what was refused.
   */
  private async findScopedMemberOrThrow(
    tx: Prisma.TransactionClient,
    scopedWhere: Prisma.HouseholdMemberWhereInput,
    unscopedWhere: Prisma.HouseholdMemberWhereInput,
    denials: ScopedMemberDenials,
  ): Promise<HouseholdMemberWithRelations> {
    const member = await tx.householdMember.findFirst({ where: scopedWhere, select: MEMBER_SELECT });

    if (member) {
      return member;
    }

    if ((await tx.householdMember.count({ where: unscopedWhere })) > 0) {
      await denials.onHidden();
    }

    denials.onMissing();
  }

  /**
   * Whether a household has members at all, ignoring the actor's read scope.
   * Only meaningful once the scoped count is known to be zero: rows existing
   * unscoped then means the actor is being denied a view (403) rather than
   * looking at an empty roster (200).
   *
   * The list path uses this instead of {@link isHiddenFromActor} because its own
   * `total` already answers the scoped half of that question (#230).
   */
  private async householdHasHiddenMembers(householdId: string): Promise<boolean> {
    return (await this.db.householdMember.count({ where: { householdId } })) > 0;
  }

  /**
   * Disambiguation primitive for the single-member read: given a scoped query
   * that produced nothing, decide whether that is a permission miss or an
   * honest absence.
   *
   * Returns `true` only when rows matching `unscopedWhere` exist but none are
   * visible under `scopedWhere` — the actor is being denied, not merely looking
   * at an empty set. Deliberately makes NO assumption about a household always
   * having at least one member. The guard in {@link deleteMembership} refuses
   * to let the last owner leave or be removed, so a household with an owner
   * keeps one, but comparing scoped against unscoped is exact either way, so
   * this check does not depend on that guard.
   *
   * The unscoped count runs only when the scoped count is zero, so an authorized
   * reader looking at a row they may not see never triggers the second query.
   */
  private async isHiddenFromActor(
    scopedWhere: Prisma.HouseholdMemberWhereInput,
    unscopedWhere: Prisma.HouseholdMemberWhereInput,
  ): Promise<boolean> {
    const visible = await this.db.householdMember.count({ where: scopedWhere });
    if (visible > 0) {
      // Rows are visible to the actor; the empty result is a page past the end.
      return false;
    }

    return (await this.db.householdMember.count({ where: unscopedWhere })) > 0;
  }
}
