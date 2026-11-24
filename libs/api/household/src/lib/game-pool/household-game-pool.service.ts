import type { GameSummary } from '@bge/database';
import {
  Action,
  DatabaseService,
  GAME_SUMMARY_SELECT,
  gameSummaryReader,
  Prisma,
  Reach,
  ResourceType,
} from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
import type { PaginatedRows, PaginationQueryDto, RandomSampleQueryDto } from '@bge/shared';
import { sampleByOffsets } from '@bge/shared';
import { Injectable } from '@nestjs/common';
import { householdRefusal } from '../household-access.helpers';
import { ACTOR_SELECT } from '../read-shapes';
import { shownName } from '../shown-name';
import { gamePoolEntryScope } from './game-pool-scope';

/** A random sample of the game pool, and how many distinct games it holds (#960). */
export interface GamePoolSample {
  gameCount: number;
  games: GameSummary[];
}

/**
 * One collection entry that puts a game in a household's game pool, and the
 * member it belongs to (#367). A member who owns the game on two platforms is
 * two owners.
 */
export interface GamePoolOwner {
  collectionEntryId: string;
  memberId: string;
  platform: { id: string; name: string };
  user: Prisma.UserGetPayload<{ select: typeof ACTOR_SELECT }>;
}

/** One game in a household's game pool, with the owners the caller can see (#367). */
export interface GamePoolRow extends GameSummary {
  owners: GamePoolOwner[];
}

/** What the owners read selects of each collection entry (#367). */
const OWNER_ENTRY_SELECT = {
  id: true,
  user: { select: ACTOR_SELECT },
  platformGame: { select: { gameId: true, platform: { select: { id: true, name: true } } } },
} as const satisfies Prisma.GameCollectionSelect;

/**
 * One fixed locale, so every server orders owners the same way whatever the
 * process's default locale is (#367).
 */
const OWNER_COLLATOR = new Intl.Collator('en');

/**
 * Shown name, then membership, then entry id, so owners list the same way on
 * every read, and one member's entries stay side by side when two members
 * share a shown name (#367).
 */
function compareOwners(a: GamePoolOwner, b: GamePoolOwner): number {
  return (
    OWNER_COLLATOR.compare(shownName(a.user), shownName(b.user)) ||
    OWNER_COLLATOR.compare(a.memberId, b.memberId) ||
    OWNER_COLLATOR.compare(a.collectionEntryId, b.collectionEntryId)
  );
}

@Injectable()
export class HouseholdGamePoolService {
  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * Up to `size` games picked uniformly at random from the game pool across
   * every live household the caller belongs to, plus how many distinct games
   * it holds (#960). The home page shows the sample, and its stats card
   * (client#614) the count. Combining per-household reads could give neither: a game shared
   * in two households would count twice, and merged samples are not uniform.
   *
   * The game is the counted unit, so a game several members own counts once.
   * The caller's own shared entries count. An entry counts when
   * {@link gamePoolEntryScope} admits it under the GameCollection ceiling, and
   * its game under the Game ceiling, which keeps out a game the caller could
   * not open at `GET /games/:id`. The GameCollection ceiling's household rule
   * is an approximation: it hides an entry excluded from one shared household
   * though shared in another, so the sample leaves that entry out too and never
   * serves more than the collection read would.
   *
   * The households, the count and the reads share one REPEATABLE READ
   * transaction: the offsets index the counted set, and under the database
   * default a membership or entry changed between them would shift every
   * offset after it.
   *
   * The Game where is composed before the empty check, so a caller with no
   * household still answers through the scope guard, with an empty sample and
   * a zero count.
   *
   * `resolveScopeSubjectId` refuses `plugin`, `system` and `external` actors,
   * as for `GET /households`: "my households" has no meaning for an actor with
   * no user. PROVISIONAL — #395.
   */
  async sampleGamePool(query: RandomSampleQueryDto): Promise<GamePoolSample> {
    const userId = resolveScopeSubjectId(this.abilityService);

    return this.db.$transaction(
      async (tx) => {
        const households = await tx.household.findMany({
          where: this.scopeComposer.compose(ResourceType.Household, Action.read, {
            deletedAt: null,
            members: { some: { userId } },
          }),
          select: { id: true },
        });
        const householdIds = households.map((household) => household.id);

        const entries = this.scopeComposer.compose(
          ResourceType.GameCollection,
          Action.read,
          gamePoolEntryScope(householdIds),
        );
        const where = this.scopeComposer.compose(ResourceType.Game, Action.read, {
          deletedAt: null,
          platformGames: { some: { collections: { some: entries } } },
        });

        if (householdIds.length === 0) {
          return { games: [], gameCount: 0 };
        }

        const gameCount = await tx.game.count({ where });
        const games = await sampleByOffsets(gameCount, query.size, gameSummaryReader(tx, where));

        return { games, gameCount };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * One household's game pool, a page at a time, for `GET /households/:id/games`
   * (#367). A row is a game, with `owners`: one per collection entry that puts
   * it in the game pool, so a member who owns it on two platforms is named
   * twice. `total` counts games, not entries, and the page is ordered by
   * title, then id, so two games with the same title page the same way on
   * every read.
   *
   * ## Who may open it
   *
   * Its members, and, when its game pool reach is `Friends`, anyone the
   * Household read ceiling lets read the household: a friend of a member when
   * the household's reach admits friends, and server staff, whose read
   * reaches every household. Staff already read every collection entry, so
   * letting them in shows nothing they could not read elsewhere; a `Private`
   * game pool still refuses them. The game pool reach is a
   * door, not a grant: it decides who may look, never what they see. A friend
   * let in sees only the entries the GameCollection ceiling already lets them
   * read, the same entries they would find in that member's collection, so
   * widening the reach never hands anyone an entry they could not read
   * before. A household with no settings row matches no `settings` clause and
   * reads as `Private`. Anyone else is refused as `GET /households/:id`
   * refuses them: 403 when the household exists, 404 when it doesn't.
   *
   * ## What it serves
   *
   * An entry counts when {@link gamePoolEntryScope} admits it for this
   * household under the GameCollection ceiling, and its game under the Game
   * ceiling, which keeps out a game the caller could not open at
   * `GET /games/:id`. The GameCollection ceiling's household rule is an
   * approximation: it hides an entry excluded from one shared household
   * though shared in another, so the game pool leaves that entry out too and
   * never serves more than the collection read would. The owners are read
   * through the same entries where, so an entry its owner excluded, or one
   * the caller can't read, names no owner, and a game with only such entries
   * is neither a row nor counted.
   *
   * The gate, the count, the page and its owners share one REPEATABLE READ
   * transaction, so the owners are the ones the counted games were counted
   * by, and a membership or entry changed between the reads can't leave a row
   * with no owner.
   *
   * `resolveScopeSubjectId` refuses `plugin`, `system` and `external` actors,
   * as for {@link sampleGamePool}: membership and friendship are a user's.
   * PROVISIONAL — #395.
   */
  async listGamePool(householdId: string, pagination: PaginationQueryDto): Promise<PaginatedRows<GamePoolRow>> {
    const userId = resolveScopeSubjectId(this.abilityService);

    return this.db.$transaction(
      async (tx) => {
        const household = await tx.household.findFirst({
          where: this.scopeComposer.compose(ResourceType.Household, Action.read, {
            id: householdId,
            deletedAt: null,
            OR: [{ members: { some: { userId } } }, { settings: { is: { gamePoolReach: Reach.Friends } } }],
          }),
          select: { id: true },
        });

        if (!household) {
          throw await householdRefusal(tx, householdId, t('common.forbidden.view'));
        }

        const entries = this.scopeComposer.compose(
          ResourceType.GameCollection,
          Action.read,
          gamePoolEntryScope([householdId]),
        );
        const where = this.scopeComposer.compose(ResourceType.Game, Action.read, {
          deletedAt: null,
          platformGames: { some: { collections: { some: entries } } },
        });

        const total = await tx.game.count({ where });
        const games = await tx.game.findMany({
          where,
          select: GAME_SUMMARY_SELECT,
          orderBy: [{ title: 'asc' }, { id: 'asc' }],
          skip: pagination.skip,
          take: pagination.pageSize,
        });

        if (games.length === 0) {
          return { rows: [], total };
        }

        const ownerEntries = await tx.gameCollection.findMany({
          where: { AND: [entries, { platformGame: { gameId: { in: games.map((game) => game.id) } } }] },
          select: OWNER_ENTRY_SELECT,
        });
        const members = await tx.householdMember.findMany({
          where: { householdId, userId: { in: [...new Set(ownerEntries.map((entry) => entry.user.id))] } },
          select: { id: true, userId: true },
        });
        const memberIdOf = new Map(members.map((member) => [member.userId, member.id]));

        const ownersOf = new Map<string, GamePoolOwner[]>();

        for (const entry of ownerEntries) {
          const memberId = memberIdOf.get(entry.user.id);

          // Unreachable inside the snapshot: the entries where admits an entry
          // only through its owner's membership in this household.
          if (memberId === undefined) {
            continue;
          }

          const owners = ownersOf.get(entry.platformGame.gameId) ?? [];
          owners.push({
            memberId,
            user: entry.user,
            collectionEntryId: entry.id,
            platform: entry.platformGame.platform,
          });
          ownersOf.set(entry.platformGame.gameId, owners);
        }

        const rows = games.map((game) => ({
          ...game,
          owners: (ownersOf.get(game.id) ?? []).sort(compareOwners),
        }));

        return { rows, total };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
