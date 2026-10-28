import { Action, DatabaseService, gameSummaryReader, Prisma, ResourceType, type GameSummary } from '@bge/database';
import { AbilityService, resolveScopeSubjectId, ScopeComposer } from '@bge/permissions';
import { sampleByOffsets, type RandomSampleQueryDto } from '@bge/shared';
import { Injectable } from '@nestjs/common';
import { gamePoolEntryScope } from './game-pool-scope';

/** A random sample of the game pool, and how many distinct games it holds (#960). */
export interface GamePoolSample {
  games: GameSummary[];
  gameCount: number;
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
}
