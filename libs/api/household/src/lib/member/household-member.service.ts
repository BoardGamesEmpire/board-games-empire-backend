import {
  Action,
  DatabaseService,
  isPrismaDependentRecordNotFoundError,
  Prisma,
  ResourceType,
  SystemRole,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, PermissionsService } from '@bge/permissions';
import { PaginationQueryDto } from '@bge/shared';
import { webhookEnvelope, WebhookEventType } from '@bge/webhooks';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UpdateMemberRoleDto } from '../dto';
import { HouseholdOwnershipTransferredEvent, type HouseholdOwnershipSnapshot } from '../events/household.events';
import { assertHouseholdExists } from '../household-access.helpers';

/**
 * Include object for member queries, so consistent user/profile/role data is
 * always fetched (the household analog of the event `ATTENDEE_INCLUDE`).
 *
 * Intentionally lean: `excludedFromHouseholds` and the sampled game-collection
 * shaping remain `HouseholdService.getHouseholdById` presentation concerns and
 * are NOT part of the roster surface (#155).
 */
export const MEMBER_INCLUDE = {
  user: {
    select: {
      id: true,
      username: true,
      profile: {
        select: {
          avatarUrl: true,
          displayName: true,
        },
      },
    },
  },
  role: {
    include: {
      role: {
        select: { id: true, name: true },
      },
    },
  },
} as const satisfies Prisma.HouseholdMemberInclude;

export type HouseholdMemberWithRelations = Prisma.HouseholdMemberGetPayload<{ include: typeof MEMBER_INCLUDE }>;

/**
 * Anything that can issue reads on this service's behalf: the base client, or a
 * transaction client inside `$transaction`. Lets a lookup live outside the
 * transaction when it has no reason to hold locks.
 */
type QueryClient = DatabaseService | Prisma.TransactionClient;

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
 * How a mutation path reports a scoped-resolution miss. Supplied per call site
 * so the denial names the attempted action rather than a generic one.
 */
interface ScopedMemberDenials {
  /** Rows exist but none are visible to this actor → 403 for the attempted action. */
  onHidden: () => never;
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
  ) {}

  /**
   * Paginated member roster, row-scoped by the actor's `read` conditions on
   * `HouseholdMember` (membership grant OR friends-visibility grant).
   *
   * A missing or soft-deleted household is a 404. An empty scoped page is
   * resolved by {@link isHiddenFromActor}: rows the actor cannot see mean a
   * permission miss (403); no rows at all — or a page past the end — is an
   * honest empty result (200).
   */
  async getMembers(householdId: string, pagination: PaginationQueryDto): Promise<HouseholdMemberWithRelations[]> {
    await assertHouseholdExists(this.db, householdId);

    const scopedWhere = {
      householdId,
      AND: this.abilityService.getCurrentResourceConditions(ResourceType.HouseholdMember, Action.read),
    } satisfies Prisma.HouseholdMemberWhereInput;

    const members = await this.db.householdMember.findMany({
      where: scopedWhere,
      include: MEMBER_INCLUDE,
      orderBy: { createdAt: 'asc' },
      skip: pagination.offset,
      take: pagination.limit || 10,
    });

    if (members.length === 0 && (await this.isHiddenFromActor(scopedWhere, { householdId }))) {
      throw new ForbiddenException(t('common.forbidden.view'));
    }

    this.logger.debug(
      `getMembers(${householdId}) → ${members.length} rows (offset ${pagination.offset}, limit ${pagination.limit})`,
    );

    return members;
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
      AND: this.abilityService.getCurrentResourceConditions(ResourceType.HouseholdMember, Action.read),
    } satisfies Prisma.HouseholdMemberWhereInput;

    const member = await this.db.householdMember.findUnique({
      where: scopedWhere,
      include: MEMBER_INCLUDE,
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
   * `manage` conditions on `HouseholdMember` (`manage:household_member` —
   * Owner/Admin of the same household).
   *
   * Guards:
   * - The actor cannot change their own role (400).
   * - A member holding `HouseholdOwner` cannot be changed here at all (400):
   *   every owner transition belongs to transfer-ownership (#158), so no
   *   owner-count reasoning is needed on this path.
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
      AND: this.abilityService.getCurrentResourceConditions(ResourceType.HouseholdMember, Action.manage),
    } satisfies Prisma.HouseholdMemberWhereInput;

    try {
      const updated = await this.db.$transaction(async (tx) => {
        const member = await this.findScopedMemberOrThrow(
          tx,
          scopedWhere,
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

        if (member.userId === actorUserId) {
          throw new BadRequestException(t('errors.household.member_role_self'));
        }

        if (member.role?.role.name === SystemRole.HouseholdOwner) {
          throw new BadRequestException(t('errors.household.member_role_owner'));
        }

        const roleId = await this.resolveRoleId(tx, updateMemberRoleDto.role);

        await tx.householdRole.upsert({
          where: { householdMemberId: member.id },
          create: { householdMemberId: member.id, roleId },
          update: { roleId },
        });

        return tx.householdMember.findUniqueOrThrow({ where: { id: member.id }, include: MEMBER_INCLUDE });
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
   * `HouseholdMember` (Owner AND Admin hold those, so scoping alone does not
   * restrict this endpoint — the gate does, and the locked owner set backs it
   * inside the transaction).
   *
   * Multiple owners are representable (`HouseholdRole` is 1:1 per *member*, but
   * N members may hold `HouseholdOwner`), so this is a swap and not a
   * normalization: co-owners are untouched, and a co-owner may transfer.
   */
  async transferOwnership(householdId: string, memberId: string): Promise<OwnershipTransferResult> {
    const initiatedAt = new Date();
    const actorUserId = this.abilityService.getActingUserId();
    await assertHouseholdExists(this.db, householdId);

    // Resolved OUTSIDE the transaction. Role ids are static seed data, not
    // household state, so holding the owner-row lock across two lookups that
    // cannot change the outcome only extends the window in which concurrent
    // departures block. A seed change mid-flight would fail the FK regardless.
    const ownerRoleId = await this.resolveRoleId(this.db, SystemRole.HouseholdOwner);
    const adminRoleId = await this.resolveRoleId(this.db, SystemRole.HouseholdAdmin);

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
          include: MEMBER_INCLUDE,
        });
        const previousOwner = await tx.householdMember.findUniqueOrThrow({
          where: { id: actor.id },
          include: MEMBER_INCLUDE,
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
   * Removes another member (#157). Row-scoped by the actor's `manage`
   * conditions on `HouseholdMember` (Owner/Admin). An Owner/Admin removing
   * their own row is deliberately allowed — it is semantically identical to
   * leaving, and the last-owner guard applies either way.
   */
  async removeMember(householdId: string, memberId: string): Promise<HouseholdMemberWithRelations> {
    await assertHouseholdExists(this.db, householdId);

    const scopedWhere = {
      id: memberId,
      householdId,
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
   * every action, so an Owner/Admin's `delete` conditions cover ALL members of
   * their household, and without the pin this endpoint would delete whichever
   * row the conditions happened to match. The pin makes "me" mean me by
   * construction, independent of how broad the actor's grants are.
   */
  async leaveHousehold(householdId: string): Promise<HouseholdMemberWithRelations> {
    const actorUserId = this.abilityService.getActingUserId();
    await assertHouseholdExists(this.db, householdId);

    const scopedWhere = {
      householdId,
      userId: actorUserId,
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
   * `HouseholdMember` row. The final delete re-applies the scoped `where`, so
   * authorization is enforced at write time as well as at read time
   * (`P2025` → 403).
   */
  private async deleteMembership(
    scopedWhere: Prisma.HouseholdMemberWhereInput & { householdId: string },
    unscopedWhere: Prisma.HouseholdMemberWhereInput,
    denials: ScopedMemberDenials,
  ): Promise<HouseholdMemberWithRelations> {
    try {
      const removed = await this.db.$transaction(async (tx) => {
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
        // on its owner rows. That is the price of correctness under READ
        // COMMITTED: there is no way to know whether the lock is needed without
        // first taking it. Households are small and departures are rare.
        const ownerMemberIds = await this.lockHouseholdOwnerRows(tx, scopedWhere.householdId);

        if (ownerMemberIds.includes(member.id) && ownerMemberIds.length <= 1) {
          throw new BadRequestException(t('errors.household.last_owner', { householdId: scopedWhere.householdId }));
        }

        await tx.excludedGame.deleteMany({ where: { householdMemberId: member.id } });
        // deleteMany: the 1:1 role relation is optional, so a role-less member
        // must not turn the cleanup into a P2025.
        await tx.householdRole.deleteMany({ where: { householdMemberId: member.id } });

        // Re-applies the scoped `where` at write time (extended unique where,
        // same shape the read paths use) so a concurrent permission change
        // between read and write still surfaces as P2025 → 403.
        await tx.householdMember.delete({ where: { ...scopedWhere, id: member.id } });

        return member;
      });

      // The household just left this user's ability surface — evict their
      // cached graph so stale Household* abilities don't linger for the TTL.
      await this.permissions.invalidateUser(removed.userId);

      return removed;
    } catch (error) {
      throw this.rethrowMutationFailure(error, t('common.forbidden.delete'), {
        ...unscopedWhere,
        operation: 'deleteMembership',
      });
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
   * Locks the household's owner-role rows and enforces that at least one other
   * `HouseholdOwner` remains. The `FOR UPDATE` matters: under READ COMMITTED,
   * two concurrent owner departures would each see the other still present in
   * a plain count and both proceed, leaving the household ownerless. Locking
   * the owner rows serializes the departures so the second one observes the
   * first and is refused.
   *
   * Only called when the departing member currently holds `HouseholdOwner` —
   * a non-owner departure cannot violate the invariant, and the concurrent
   * "promoted to owner mid-delete" case is impossible until transfer-ownership
   * (#158) exists, which will take this same lock.
   */
  /**
   * Locks the household's `HouseholdOwner` role rows for the remainder of the
   * transaction and returns the `HouseholdMember.id`s holding them.
   *
   * The lock, not the count, is the point. Under READ COMMITTED two concurrent
   * owner transitions each read the pre-image and each conclude they are safe;
   * `FOR UPDATE OF hr` serializes them so the second observes the first. Both
   * callers need that, for different invariants:
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
   * a spec in this lib, which catches a later `@map` rename; that it actually
   * serializes is #239's integration work.
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
   * Resolves a `SystemRole` to its `roles` row id, failing loud when the row is
   * absent.
   *
   * Explicit resolution rather than a nested `role: { connect: { name } }`: a
   * missing row (seed drift — a new `SystemRole` shipped before the seed
   * reseeds) raises the same `P2025` from the connect target as a vanished
   * member row raises from the write, and {@link rethrowMutationFailure} would
   * report a server misconfiguration to the caller as their own lack of
   * permission. Repo-wide generalization is #242.
   */
  private async resolveRoleId(client: QueryClient, name: SystemRole): Promise<string> {
    const role = await client.role.findUnique({ where: { name }, select: { id: true } });

    if (!role) {
      throw new InternalServerErrorException(t('errors.household.role_not_provisioned', { role: name }));
    }

    return role.id;
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
    const member = await tx.householdMember.findFirst({ where: scopedWhere, include: MEMBER_INCLUDE });

    if (member) {
      return member;
    }

    if ((await tx.householdMember.count({ where: unscopedWhere })) > 0) {
      denials.onHidden();
    }

    denials.onMissing();
  }

  /**
   * Single disambiguation primitive for both read paths: given a scoped query
   * that produced nothing, decide whether that is a permission miss or an
   * honest absence.
   *
   * Returns `true` only when rows matching `unscopedWhere` exist but none are
   * visible under `scopedWhere` — the actor is being denied, not merely looking
   * at an empty set. Deliberately makes NO assumption about a household always
   * having at least one member: that invariant is upheld today only by the
   * absence of a removal endpoint, and #157 (remove member / leave household) is
   * exactly where it would come under pressure. Comparing scoped against
   * unscoped is exact either way.
   *
   * The unscoped count runs only when the scoped count is zero, so an authorized
   * reader paging past the end never triggers the second query.
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
