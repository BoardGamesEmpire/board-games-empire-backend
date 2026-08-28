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
import { AbilityService, PermissionsService } from '@bge/permissions';
import { PaginatedRows, PaginationQueryDto } from '@bge/shared';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import assert from 'node:assert';
import { CreateHouseholdDto, UpdateHouseholdDto } from './dto';
import { assertHouseholdExists, householdExists } from './household-access.helpers';

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

  members: {
    include: {
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
            select: {
              id: true,
              name: true,
            },
          },
        },
      },
    },
  },
} satisfies Prisma.HouseholdInclude;

export type HouseholdWithRelations = Prisma.HouseholdGetPayload<{ include: typeof HOUSEHOLD_LIST_INCLUDE }>;

@Injectable()
export class HouseholdService {
  private readonly logger = new Logger(HouseholdService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly permissions: PermissionsService,
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
        },

        languageTag: {
          select: {
            id: true,
            tag: true,
            name: true,
          },
        },

        members: {
          include: {
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
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },

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
      // (P2025 → 403). Keeps the two outcomes distinguishable.
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
      this.logger.error(`Error updating household with id ${id}`, error);
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.update'));
      }

      throw error;
    }
  }

  /**
   * Paginated households the actor may READ — which widens with the caller.
   * A plain user receives their memberships AND friends' `Friends`-visible
   * households (`read:households` OR `read:households:friends`, both on the
   * base `User` role); Owner/Admin/Moderator receive every household via their
   * unconditioned `subject: 'all'` grants. That is the role- and
   * friendship-dependent meaning #365 exists to settle.
   *
   * Callers that need a set whose absence means something — "this household is
   * no longer mine" — want {@link getHouseholdsForMember} instead.
   */
  async getHouseholdsForUser(pagination: PaginationQueryDto): Promise<PaginatedRows<HouseholdWithRelations>> {
    return this.paginateHouseholds(
      {
        deletedAt: null,
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.read),
      },
      pagination,
    );
  }

  /**
   * Paginated households the caller holds a `HouseholdMember` row for,
   * whatever their server role (#364). Unlike {@link getHouseholdsForUser}
   * this means one thing for every caller, which is what lets a client treat
   * "cached locally but absent here" as "you were removed or it was deleted"
   * rather than as a scope it has to guess at.
   *
   * Three constraints carry that guarantee, and each is asserted rather than
   * left to the shape of this query:
   *
   * - The membership clause is the scope (D-364-2). The ability conditions
   *   alone would readmit friends' `Friends`-visible households, which the
   *   caller is not a member of.
   * - It is ANDed with those conditions, never a substitute for them
   *   (D-364-3). For an `apiKey` actor the conditions carry the key ∩ owner
   *   floor, so dropping them would widen a narrow key to the owner's full
   *   membership list.
   * - `deletedAt: null` stays (D-364-5). `deleteHousehold` retains member rows
   *   by design, so the membership clause still matches a soft-deleted
   *   household.
   *
   * `HouseholdMember` has no `deletedAt` — removal is a hard delete — so with
   * those in place absence is unambiguous FOR A USER SESSION. It is not
   * unconditional: because the ability conditions are ANDed in, an API key
   * scoped narrower than its owner makes absence also mean "outside this key's
   * scope", so a key-authenticated read must not drive a cache purge. That is
   * the intended trade — a widened key would be the worse bug — and it is
   * documented on the route. The key permission model is unbuilt (#270).
   */
  async getHouseholdsForMember(pagination: PaginationQueryDto): Promise<PaginatedRows<HouseholdWithRelations>> {
    const userId = this.resolveMemberUserId();

    return this.paginateHouseholds(
      {
        deletedAt: null,
        members: { some: { userId } },
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Household, Action.read),
      },
      pagination,
    );
  }

  /**
   * The caller's own user id, or a 403 for an actor kind that has none.
   *
   * Resolved before the query runs, and the rejection is the intended answer:
   * "my households" has no meaning for an actor with no user behind it. It must
   * never soften into an empty page — an empty page tells a client its
   * memberships were removed.
   *
   * PROVISIONAL (D-364-4). A plugin may legitimately act on a user's behalf, so
   * this may well be the wrong answer for plugin actors; today it reflects the
   * absence of polymorphic actor attribution (deferred to #59) rather than a
   * decision about memberships. #395 revisits it, along with anonymous actors,
   * who could reach household-adjacent access through a game play session or
   * event linked to a household.
   *
   * The message is re-thrown rather than passed through: `getActingUserId`
   * phrases its rejection as being about user-attributed WRITES — accurate for
   * its usual callers, wrong on a GET — and does not localise it. A MISSING
   * actor is a different failure (a plain `Error`, meaning nothing primed the
   * context) and is left to propagate as the 500 it is.
   */
  private resolveMemberUserId(): string {
    try {
      return this.abilityService.getActingUserId();
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw new ForbiddenException(t('common.forbidden.access'));
      }

      throw error;
    }
  }

  /**
   * The shared read behind both list endpoints: one page of households plus the
   * total matching row count for the response envelope (#230). Scope is the
   * caller's business; everything below it is invariant, and shared so a fix to
   * either invariant cannot land on one read and miss the other.
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
   * read — `getHouseholdById`, `getHouseholdsForUser`, `getHouseholdsForMember`
   * and `updateHousehold` all filter `deletedAt: null`. Outstanding invites to
   * the household are revoked in the same transaction so a stale token can never
   * be accepted into a dead household. Members and game-collection shares are
   * intentionally left in place — a soft delete is reversible and reads already
   * exclude the household; hard cascade/cleanup is deferred to the (future)
   * purge path.
   *
   * That retention is load-bearing in the other direction too: because the
   * member rows survive, a membership clause alone still matches this household,
   * which is why `getHouseholdsForMember` cannot drop its `deletedAt` filter
   * (D-364-5). Anything added to that list must filter it as well.
   */
  async deleteHousehold(id: string) {
    try {
      // Existence first (→ 404); the scoped update below enforces the delete
      // policy (owner-only), and a non-matching `where` (→ P2025) maps to 403 —
      // consistent with updateHousehold and GameService.delete/update.
      await assertHouseholdExists(this.db, id);

      const { household, memberUserIds } = await this.db.$transaction(async (tx) => {
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
        const members = await tx.householdMember.findMany({
          where: { householdId: id },
          select: { userId: true },
        });

        return { household, memberUserIds: members.map((member) => member.userId) };
      });

      // Evict every member's graph so stale Household* abilities don't linger for
      // the cache TTL. The graph query also excludes soft-deleted memberships, so
      // the rebuild omits this household even before the eviction lands.
      await this.permissions.invalidateUsers(memberUserIds);

      return household;
    } catch (error) {
      this.logger.error(`Error deleting household with id ${id}`, error);
      // Existence was confirmed above, so a scoped-update miss means the actor
      // isn't permitted to delete this household (owner-only) → 403.
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new ForbiddenException(t('common.forbidden.delete'));
      }

      throw error;
    }
  }
}
