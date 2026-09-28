import type { Household } from '@bge/database';
import {
  Action,
  DatabaseService,
  HouseholdMembershipOrigin,
  InviteStatus,
  isPrismaDependentRecordNotFoundError,
  isPrismaUniqueConstraintError,
  Prisma,
  ResourceType,
  SystemRole,
} from '@bge/database';
import { t } from '@bge/i18n';
import { canonicalizeTag } from '@bge/locale';
import {
  AbilityService,
  PermissionsService,
  resolveActingUserIdOrNull,
  resolveScopeSubjectId,
  ScopeComposer,
} from '@bge/permissions';
import { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import assert from 'node:assert';
import { HOUSEHOLD_RESTORE_PERMISSION_SLUG, HOUSEHOLD_RESTORE_WINDOW_MS } from './constants/household.constants';
import { CreateHouseholdDto, UpdateHouseholdDto } from './dto';
import { assertHouseholdExists, householdExists } from './household-access.helpers';
import { MEMBER_SELECT, PENDING_INVITE_SELECT } from './read-shapes';

/**
 * Relations returned with every household in the list read. Extracted so the
 * payload type below stays in step with what the query actually selects.
 */
const HOUSEHOLD_LIST_INCLUDE = {
  languageTag: {
    select: {
      id: true,
      tag: true,
      name: true,
    },
  },

  members: { select: MEMBER_SELECT },
} satisfies Prisma.HouseholdInclude;

export type HouseholdWithRelations = Prisma.HouseholdGetPayload<{ include: typeof HOUSEHOLD_LIST_INCLUDE }>;

/**
 * What a soft delete returns: the tombstoned row, and when the actor's window
 * to restore it ends, or `null` when the delete opened none for them (#175).
 */
export interface HouseholdDeletion {
  readonly household: Household;
  readonly restorableUntil: Date | null;
}

@Injectable()
export class HouseholdService {
  private readonly logger = new Logger(HouseholdService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly permissions: PermissionsService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  async getHouseholdById(id: string) {
    const household = await this.db.household.findUnique({
      where: {
        id,
        deletedAt: null,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.read),
      },
      include: {
        invites: {
          where: {
            AND: [{ status: InviteStatus.Pending }],
          },
          select: PENDING_INVITE_SELECT,
        },

        languageTag: {
          select: {
            id: true,
            tag: true,
            name: true,
          },
        },

        members: {
          select: {
            ...MEMBER_SELECT,

            // Composed onto the roster shape rather than added to it: the
            // sampled game-collection presentation below is this read's
            // concern, not part of the roster surface every other member read
            // returns (#155).
            excludedFromHouseholds: {
              select: {
                gameCollectionId: true,
              },
            },
          },
        },
      },
    });

    if (!household) {
      // The scoped read matched nothing: probe existence to distinguish a
      // missing household (404) from one that exists but isn't visible (403).
      if (await householdExists(this.db, id)) {
        throw new ForbiddenException(t('common.forbidden.view'));
      }
      throw new NotFoundException(t('errors.household.not_found', { id }));
    }

    const memberGamesPromises = household.members.map((member) =>
      this.getSelectMemberGames(
        member.userId,
        member.excludedFromHouseholds.map(({ gameCollectionId }) => gameCollectionId),
      ),
    );

    const memberGames = await Promise.all(memberGamesPromises);
    const memberGamesMap = memberGames.reduce(
      (acc, { memberId, gameCollections }) => ({
        ...acc,
        [memberId]: gameCollections,
      }),
      {} as Record<string, { id: string; platformGame: { id: string; game: { id: string; title: string } } }[]>,
    );

    const members = household.members.map((member) => ({
      ...member,
      user: {
        ...member.user,
        gameCollections: memberGamesMap[member.userId] || [],
      },
    }));

    return {
      ...household,
      members,
    };
  }

  /**
   * @todo refine game selection permissions
   */
  private async getSelectMemberGames(memberId: string, excludedCollectionIds: string[]) {
    // Sample the 5 collection ids DB-side (ORDER BY random() LIMIT 5) rather
    // than loading every owned row — with full game descriptions — into memory
    // just to shuffle and slice. random() is also a uniform sample, unlike the
    // former `sort(() => 0.5 - Math.random())`, which is biased and O(n log n).
    const exclusion =
      excludedCollectionIds.length > 0
        ? Prisma.sql`AND id NOT IN (${Prisma.join(excludedCollectionIds)})`
        : Prisma.empty;

    const sampled = await this.db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM game_collections
      WHERE user_id = ${memberId}
        AND deleted_at IS NULL
        ${exclusion}
      ORDER BY random()
      LIMIT 5
    `);

    const sampledIds = sampled.map((row) => row.id);
    if (sampledIds.length === 0) {
      return { gameCollections: [], memberId };
    }

    // Fetch the rich shape for only the sampled rows (order is irrelevant for a
    // random sample, so `id IN (...)` is fine).
    const gameCollections = await this.db.gameCollection.findMany({
      where: { id: { in: sampledIds } },
      select: {
        id: true,
        platformGame: {
          select: {
            id: true,

            game: {
              select: {
                id: true,
                title: true,
                thumbnail: true,
                description: true,
              },
            },
          },
        },
      },
    });

    return {
      gameCollections,
      memberId,
    };
  }

  /**
   * Resolves a client-supplied BCP 47 tag to the LanguageTag row id.
   * 400 on syntactically invalid tags and on tags outside the vocabulary.
   */
  private async resolveLanguageTagId(tag: string | undefined): Promise<string | undefined> {
    if (tag === undefined) {
      return undefined;
    }

    const canonical = canonicalizeTag(tag);
    assert(canonical, new BadRequestException(t('errors.household.invalid_language_tag', { tag })));

    const languageTag = await this.db.languageTag.findUnique({
      where: { tag: canonical },
      select: { id: true },
    });
    assert(languageTag, new BadRequestException(t('errors.household.language_tag_unsupported', { tag: canonical })));

    return languageTag.id;
  }

  async create(createHouseholdDto: CreateHouseholdDto) {
    const userId = this.abilityService.getActingUserId();
    const { language, clientRequestId: rawClientRequestId, ...rest } = createHouseholdDto;
    const languageTagId = await this.resolveLanguageTagId(language);

    // A blank key is not a key. The DTO rejects one over HTTP, but `create` is
    // also callable in-process, and persisting '' would put every keyless
    // internal create by a user into one shared idempotency bucket — the second
    // would silently "replay" the first. Trim so both entry points agree on the
    // bucket: the DTO trims too, so a padded key can't split into two rows.
    const clientRequestId = rawClientRequestId?.trim() || undefined;

    let household: Household;
    try {
      // Optimistic insert — no pre-flight key lookup. A concurrent duplicate
      // submission races here; the loser trips the composite unique and is
      // recovered in the catch below (same shape as GameService.create's
      // GameSource race recovery).
      household = await this.db.household.create({
        data: {
          ...rest,
          clientRequestId,
          languageTag: languageTagId
            ? {
                connect: {
                  id: languageTagId,
                },
              }
            : undefined,

          createdBy: {
            connect: {
              id: userId,
            },
          },

          members: {
            create: {
              userId,
              // Provenance (#276). The founder is the one membership that is not
              // produced by `addMemberWithin`: this create is deliberately NOT
              // transactional, which is what makes the P2002 replay recovery
              // below legal (Postgres aborts a transaction on constraint
              // violation, so a catch-and-recover inside one cannot re-read).
              // Routing it through the seam would force a transaction it does
              // not need and break that. It is also the only case where
              // `HouseholdOwner` is legitimate.
              //
              // Quota (#159): this row is not CHARGED — creation never consumes,
              // so a household can always be created regardless of the cap — but
              // it IS COUNTED. `countHouseholdMembers` counts every row in the
              // household, so a cap of N is a roster cap of N with the founder
              // inside it, and the first admission through the seam already sees
              // usage of 1.
              origin: HouseholdMembershipOrigin.Founder,
              addedById: userId,
              role: {
                create: {
                  role: {
                    connect: {
                      name: SystemRole.HouseholdOwner,
                    },
                  },
                },
              },
            },
          },
        },
      });
    } catch (error) {
      const replayed =
        clientRequestId === undefined ? null : await this.recoverKeyedCreate(error, userId, clientRequestId);

      if (!replayed) {
        throw error;
      }

      return replayed;
    }

    // The acting user just became a HouseholdOwner — evict their cached ability
    // graph so the new household-scoped grants resolve on their next request.
    await this.permissions.invalidateUser(userId);

    return household;
  }

  /**
   * Idempotent replay (#210). A create that trips the `(createdById,
   * clientRequestId)` unique means the original COMMITTED — the retry exists
   * only because its response was lost in transit — so return the original row
   * rather than surfacing the conflict.
   *
   * Returns `null` when the caller should rethrow: a P2002 on some other unique
   * with no row under this key, or any non-unique failure.
   *
   * THE ROW DECIDES, NOT THE ERROR SHAPE. This previously discriminated on
   * `meta.target`, accepting three spellings because Prisma has reported
   * different ones across provider/version combinations. Under Prisma 7 with
   * the `PrismaPg` driver adapter it reports NONE of them: `meta` carries no
   * usable `target` at all, so the discriminator never matched, every keyed
   * retry rethrew, and #210's guarantee inverted into a 500 on exactly the
   * request it exists to make safe. Verified end-to-end in
   * `apps/api-e2e/src/household/household-idempotency.spec.ts` (#257), which is
   * how it was found — the unit specs all fabricated a `meta.target`, so the
   * mock was the only thing the discriminator was ever tested against.
   *
   * Keying off the lookup instead is both correct and shape-independent: a row
   * under `(userId, clientRequestId)` means this key's create already
   * committed, which is precisely the condition a replay must return, whatever
   * the database chose to say about which index it was. `clientRequestId` is
   * the only unique on `households` that involves it, so there is no other
   * conflict this could be confused with.
   */
  private async recoverKeyedCreate(error: unknown, userId: string, clientRequestId: string): Promise<Household | null> {
    if (!isPrismaUniqueConstraintError(error)) {
      return null;
    }

    // The lookup deliberately omits the `deletedAt: null` filter: the keyed
    // create semantically succeeded, and that row — even if since soft-deleted —
    // is its canonical outcome for the client to reconcile against.
    const existing = await this.db.household.findUnique({
      where: { createdById_clientRequestId: { createdById: userId, clientRequestId } },
    });

    if (!existing) {
      // Should be unreachable. `clientRequestId` participates in the only unique
      // on `households`, and the nested member insert cannot collide on a
      // freshly generated household id, so a P2002 with no row under this key
      // means something we do not understand happened.
      //
      // WARN, not debug: `resolvePinoLevel` drops debug in production, and this
      // is the branch that reinstates a 500 on a legitimate retry — the exact
      // failure this recovery path exists to remove, and one that took an e2e
      // suite to notice the first time. Matches the level its twin in
      // `FeedbackService.recoverKeyedSubmit` uses for the same tripwire. The
      // whole `meta` is logged rather than just `target`, since `target` being
      // absent is what made the old discriminator useless.
      this.logger.warn(
        `Keyed household create raised P2002 with no row under the key; ` +
          `meta=${JSON.stringify(error.meta)}. Rethrowing.`,
      );

      return null;
    }

    this.logger.debug(`Idempotent replay of household create for user ${userId}; returning household ${existing.id}`);

    // Evict on replay too. Replays are usually pure no-ops, but the one
    // pathological original — committed, then crashed before its own eviction
    // ran — leaves the owner's ability graph stale; the retry is the natural
    // place to heal it, and eviction is idempotent and cheap.
    await this.permissions.invalidateUser(userId);

    return existing;
  }

  async updateHousehold(id: string, updateHouseholdDto: UpdateHouseholdDto) {
    if (Object.keys(updateHouseholdDto).length === 0) {
      throw new BadRequestException(t('common.at_least_one_field'));
    }

    const { language, ...rest } = updateHouseholdDto;
    const languageTagId = await this.resolveLanguageTagId(language);

    try {
      // Existence first (→ 404); the scoped update below enforces permission
      // (P2025 → 403, unless a delete landed in between: see
      // `scopedWriteRefusal`). Keeps the two outcomes distinguishable.
      await assertHouseholdExists(this.db, id);

      return await this.db.household.update({
        where: {
          id,
          deletedAt: null,
          AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.update),
        },
        data: {
          ...rest,
          languageTag: languageTagId
            ? {
                connect: {
                  id: languageTagId,
                },
              }
            : undefined,
        },
      });
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw await this.scopedWriteRefusal(id, t('common.forbidden.update'));
      }

      this.logger.error(`Error updating household with id ${id}`, error);
      throw error;
    }
  }

  /**
   * Paginated households the caller is a member of. FIRST-PERSON: the scope is
   * the caller's own `HouseholdMember` rows, so this route answers the same
   * question for everybody (#417), applying the rule #365 settled: the path
   * names the scope. It is composed with the caller's ceiling in the one place
   * allowed to write both halves (#416):
   *
   * ```
   * rows = my memberships AND what my ability admits
   * ```
   *
   * It used to answer three. The scope WAS the permission ceiling, so a plain
   * user received their memberships, a user with friends also received those
   * friends' `Friends`-visible households, and Owner/Admin/Moderator received
   * every household on the server — one route, and the caller decided which
   * question it had asked. `pagination.total` was scoped the same way, so a
   * client could not tell the cases apart either. That is the ambiguity #365
   * was filed about, removed here at its original instance.
   *
   * Friend visibility is narrowed, not withdrawn. `read:households:friends`
   * still reaches a friend's `Friends`-visible household through
   * {@link getHouseholdById}, which ANDs the ceiling exactly as before; what it
   * loses is its effect on this LIST. Reading another subject's households as a
   * list belongs on a path-parameterized route (#485), unbuilt until a consumer
   * needs it; the all-subject staff surface is #419 and gets its own
   * controllers.
   *
   * Three constraints carry the guarantee (#364), and each is asserted rather
   * than left to the shape of this query:
   *
   * - The membership clause is the scope. The ability conditions
   *   alone would readmit friends' `Friends`-visible households, which the
   *   caller is not a member of — and for staff, every household on the
   *   server.
   * - It is ANDed with those conditions, never a substitute for them. For an
   *   `apiKey` actor the conditions carry the key ∩ owner
   *   floor, so dropping them would widen a narrow key to the owner's full
   *   membership list. Routing both halves through the composer is what makes
   *   dropping them unrepresentable rather than merely discouraged.
   * - `deletedAt: null` stays. `deleteHousehold` retains member rows
   *   by design, so the membership clause still matches a soft-deleted
   *   household.
   *
   * `HouseholdMember` has no `deletedAt` — removal is a hard delete — so for a
   * user session this scope leaves a row's absence meaning exactly "removed or
   * deleted". For an API key it does not: the ANDed conditions carry the
   * key ∩ owner floor, so absence also means "outside this key's scope". That
   * is the intended trade — a widened key would be the worse bug. What a
   * client may conclude from absence, including how pagination limits it, is
   * the route's contract and is stated once, in its OpenAPI description.
   *
   * `resolveScopeSubjectId` refuses `plugin`, `system` and `external` actors
   * (#417): "my households" has no meaning for an actor with no user, and
   * the refusal must never soften into an empty page, which would tell a client
   * its memberships were removed. PROVISIONAL — #395.
   */
  async getHouseholdsForUser(pagination: PaginationQueryDto): Promise<PaginatedRows<HouseholdWithRelations>> {
    const userId = resolveScopeSubjectId(this.abilityService);

    return this.paginateHouseholds(
      this.scopeComposer.compose(ResourceType.Household, Action.read, {
        deletedAt: null,
        members: { some: { userId } },
      }),
      pagination,
    );
  }

  /**
   * One page of households plus the total matching row count for the response
   * envelope (#230). Scope is the caller's business; everything below it holds
   * whatever the scope, so a household list that declares a different one
   * (#485) would read through here rather than restate either invariant.
   *
   * Rows and count share a REPEATABLE READ transaction: Prisma's default batch
   * isolation is the database default (READ COMMITTED on Postgres), where each
   * statement takes its own snapshot and a concurrent create or delete between
   * the two makes `hasMore` disagree with the rows actually sent.
   *
   * The order is total: `createdAt` alone would let rows created in the same
   * transaction share a key and drift across page boundaries between requests —
   * page 2 re-showing a row page 1 already had, and dropping another.
   */
  private async paginateHouseholds(
    where: Prisma.HouseholdWhereInput,
    pagination: PaginationQueryDto,
  ): Promise<PaginatedRows<HouseholdWithRelations>> {
    const [rows, total] = await this.db.$transaction(
      [
        this.db.household.findMany({
          where,
          include: HOUSEHOLD_LIST_INCLUDE,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip: pagination.skip,
          take: pagination.pageSize,
        }),

        this.db.household.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
  }

  /**
   * Soft-delete: the row is retained (`deletedAt` stamped) and hidden from every
   * read — `getHouseholdById`, `getHouseholdsForUser` and `updateHousehold` all
   * filter `deletedAt: null`. Outstanding invites to the household are revoked
   * in the same transaction so a stale token can never be accepted into a dead
   * household. Members and game-collection shares are intentionally left in
   * place — a soft delete is reversible ({@link restoreHousehold}) and reads
   * already exclude the household; hard cascade/cleanup is deferred to the
   * purge path (#543).
   *
   * That retention is load-bearing in the other direction too: because the
   * member rows survive, a membership clause alone still matches this household,
   * which is why the scope `getHouseholdsForUser` declares cannot drop its
   * `deletedAt` filter (#364). A read that adopts that scope inherits the
   * filter; one that builds its own membership clause must add it.
   *
   * ## Who can undo it (#175)
   *
   * When the actor is one of the household's owners, every owner gets a
   * recovery grant for {@link HOUSEHOLD_RESTORE_WINDOW_MS}, and
   * `restorableUntil` says when it ends. Every owner, because any owner may
   * delete, so a co-owner must not lose the household with no way back because
   * another one did.
   *
   * Any other actor gets no window: staff deleting through
   * `delete:household:administer`, or an actor with no user behind it. That is
   * moderation, and a grant to the owners would let them reverse it. Staff
   * restore through their own slug instead, and `restorableUntil` is `null`.
   *
   * Ownership decides, not which rule the write matched. Staff who are among
   * the household's owners delete as its owners, and every owner gets the
   * window: nothing in the request tells moderation from an owner deleting
   * their own household. Moderating a household they own is for staff who do
   * not.
   *
   * The other order has no shortcut. When an owner deleted first and staff
   * want the household to stay down, staff restore it and delete it again:
   * the restore revokes the owners' windows, and a staff delete issues none.
   */
  async deleteHousehold(id: string): Promise<HouseholdDeletion> {
    // `null` for an actor with no user behind it, which then owns nothing.
    const actorUserId = resolveActingUserIdOrNull(this.abilityService);

    try {
      // Existence first (→ 404); the scoped update below enforces the delete
      // policy (owner-only), and a non-matching `where` (→ P2025) maps to 403 —
      // consistent with updateHousehold and GameService.delete/update — unless a
      // concurrent delete landed in between (`scopedWriteRefusal`).
      await assertHouseholdExists(this.db, id);

      const { household, memberUserIds, restorableUntil } = await this.db.$transaction(async (tx) => {
        const household = await tx.household.update({
          where: {
            id,
            deletedAt: null,
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.delete),
          },
          data: { deletedAt: new Date() },
        });

        // Outstanding invites to a dead household can never be accepted.
        await tx.invite.updateMany({
          where: {
            householdId: id,
            status: { in: [InviteStatus.Pending, InviteStatus.AwaitingApproval] },
          },
          data: { status: InviteStatus.Revoked },
        });

        // Member rows survive the soft delete; capture them so their cached
        // ability graphs can be evicted (the household just left their surface).
        // Read after the update, which holds the row lock a role transition
        // needs, so the owners seen here cannot be mid-swap.
        const members = await tx.householdMember.findMany({
          where: { householdId: id },
          select: { userId: true, role: { select: { role: { select: { name: true } } } } },
        });

        const ownerUserIds = members
          .filter((member) => member.role?.role.name === SystemRole.HouseholdOwner)
          .map((member) => member.userId);

        const restorableUntil =
          actorUserId !== null && ownerUserIds.includes(actorUserId)
            ? await this.grantRecovery(tx, id, ownerUserIds, actorUserId)
            : null;

        return { household, memberUserIds: members.map((member) => member.userId), restorableUntil };
      });

      // Evict every member's graph so stale Household* abilities don't linger for
      // the cache TTL. The graph query also excludes soft-deleted memberships, so
      // the rebuild omits this household even before the eviction lands. The
      // owners are members, so the same eviction picks up their recovery grants.
      await this.permissions.invalidateUsers(memberUserIds);

      return { household, restorableUntil };
    } catch (error) {
      // A scoped-update miss: the actor may not delete this household
      // (owner-only), or a concurrent delete got there first.
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw await this.scopedWriteRefusal(id, t('common.forbidden.delete'));
      }

      this.logger.error(`Error deleting household with id ${id}`, error);
      throw error;
    }
  }

  /**
   * What a scoped write on a household that matched nothing (P2025) should
   * answer. The existence probe in front of it takes no lock, so a soft-delete
   * can commit in between, and a second of two concurrent deletes then misses
   * on `deletedAt: null` rather than on permission. The household is gone, so
   * the answer is the 404 every route gives a deleted household (#299), not a
   * denial. Otherwise it is there and the actor may not do this: 403.
   *
   * Not logged: both are outcomes the endpoint is specified to produce.
   */
  private async scopedWriteRefusal(
    id: string,
    forbidden: ReturnType<typeof t>,
  ): Promise<ForbiddenException | NotFoundException> {
    return (await householdExists(this.db, id))
      ? new ForbiddenException(forbidden)
      : new NotFoundException(t('errors.household.not_found', { id }));
  }

  /**
   * Undoes {@link deleteHousehold} (#175): clears `deletedAt`, so every read
   * sees the household again and its members' household-scoped grants come
   * back. Revoked invites stay revoked, and nothing is emitted, like the delete
   * (#245).
   *
   * The write is scoped by the actor's `update` rules on Household, and the
   * only ones that can match a deleted row are the two restore slugs, both
   * conditioned on the tombstone: an owner's recovery grant, pinned to this
   * household until its window ends, or staff's. The `deletedAt: { not: null }`
   * filter says the same thing again, so no other `update` rule can turn this
   * into an edit of a live household.
   *
   * An actor with no `update` rule on Household at all, such as a stranger or
   * an owner whose window lapsed, gets CASL's deny-all `{ OR: [] }`. Prisma
   * drops that inside `AND` (prisma#21856), which would leave only the
   * tombstone filter; `DatabaseService` installs `createCaslExtension`, which
   * hoists it to the top of the `where` so it holds.
   *
   * In the same transaction every recovery grant for the household goes,
   * whoever restored it: the window was for undoing THIS delete, and a
   * co-owner's grant outliving the restore would reach the household's next
   * one. That includes a grant an operator put on the key: a standing right to
   * restore is staff's slug, not this one. After commit every member is
   * evicted, since all of their household grants come back, not only the
   * restorer's.
   *
   * A miss (P2025) is resolved by {@link restoreRefusal}: 409 when the
   * household is live and the actor may read it, otherwise 404.
   */
  async restoreHousehold(id: string): Promise<Household> {
    try {
      const { household, memberUserIds } = await this.db.$transaction(async (tx) => {
        const household = await tx.household.update({
          where: {
            id,
            deletedAt: { not: null },
            AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.update),
          },
          data: { deletedAt: null },
        });

        // Grants only. An operator's denial on the same key outlives the
        // restore, as it outlived the delete (`grantRecovery`). `inverted` is
        // nullable, so "not a denial" is spelled out: `NOT: { inverted: true }`
        // would drop the null rows.
        await tx.userPermission.deleteMany({
          where: {
            resourceType: ResourceType.Household,
            resourceId: id,
            permission: { slug: HOUSEHOLD_RESTORE_PERMISSION_SLUG },
            OR: [{ inverted: null }, { inverted: false }],
          },
        });

        const members = await tx.householdMember.findMany({
          where: { householdId: id },
          select: { userId: true },
        });

        return { household, memberUserIds: members.map((member) => member.userId) };
      });

      await this.permissions.invalidateUsers(memberUserIds);

      return household;
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw await this.restoreRefusal(id);
      }

      this.logger.error(`Error restoring household with id ${id}`, error);
      throw error;
    }
  }

  /**
   * Why a restore matched nothing, in the terms the caller may learn.
   *
   * 409 only when the household is live AND the actor can read it: an offline
   * retry of a restore that already landed, or a co-owner who got there first,
   * gets a distinct "already done". Everything else is 404, the same answer
   * whether the id is unknown, the window has lapsed, or the actor is a plain
   * member or a stranger. The probe is read-scoped for that reason: a stranger
   * learns nothing from the difference.
   */
  private async restoreRefusal(id: string): Promise<ConflictException | NotFoundException> {
    const readable = await this.db.household.count({
      where: {
        id,
        deletedAt: null,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.read),
      },
    });

    return readable > 0
      ? new ConflictException(t('errors.household.not_deleted', { id }))
      : new NotFoundException(t('errors.household.not_found', { id }));
  }

  /**
   * Issues each owner the recovery grant, all expiring together, and returns
   * when the acting owner's undo ends, or `null` when this delete opened none
   * for them.
   *
   * Create-only. Every restore revokes the household's recovery grants, so a
   * row already on an owner's key was put there by an operator, and it stays
   * exactly as set: a denial is not turned into a grant, and a grant is not
   * re-dated or re-attributed. That owner gets no new window, and when the
   * owner is the actor the result is `null`: the response never promises an
   * undo this delete did not open.
   *
   * An operator's denial of the slug pinned to no household also means `null`
   * while it is in force, because the loader applies denials after grants and
   * so it outranks the pinned one. The grant is still written, and counts if
   * the denial is lifted inside the window.
   *
   * A missing slug is a server error that rolls the delete back, not a delete
   * committed with no way to undo it.
   */
  private async grantRecovery(
    tx: Prisma.TransactionClient,
    householdId: string,
    ownerUserIds: readonly string[],
    grantedById: string,
  ): Promise<Date | null> {
    const permission = await tx.permission.findFirst({
      where: { slug: HOUSEHOLD_RESTORE_PERMISSION_SLUG, retiredAt: null },
      select: { id: true },
    });

    if (!permission) {
      throw new InternalServerErrorException(
        t('errors.household.permission_not_provisioned', { slug: HOUSEHOLD_RESTORE_PERMISSION_SLUG }),
      );
    }

    const now = Date.now();
    const expiresAt = new Date(now + HOUSEHOLD_RESTORE_WINDOW_MS);
    const onKey = { permissionId: permission.id, resourceType: ResourceType.Household };

    // One statement for every owner, and an existing row wins (ON CONFLICT DO
    // NOTHING). What comes back is only what this delete created.
    const created = await tx.userPermission.createManyAndReturn({
      data: ownerUserIds.map((userId) => ({ ...onKey, resourceId: householdId, userId, grantedById, expiresAt })),
      skipDuplicates: true,
      select: { userId: true },
    });

    if (!created.some((grant) => grant.userId === grantedById)) {
      return null;
    }

    const deniedEverywhere = await tx.userPermission.count({
      where: {
        ...onKey,
        userId: grantedById,
        resourceId: null,
        inverted: true,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date(now) } }],
      },
    });

    return deniedEverywhere > 0 ? null : expiresAt;
  }
}
