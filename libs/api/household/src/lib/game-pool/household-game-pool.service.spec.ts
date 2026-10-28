import { Action, GAME_SUMMARY_SELECT, Prisma, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import { RandomSampleQueryDto } from '@bge/shared';
import {
  createMockAbilityService,
  createMockDatabaseService,
  createTestingModuleWithDb,
  MOCK_ACTING_USER_ID,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { ForbiddenException } from '@nestjs/common';
import { gamePoolEntryScope } from './game-pool-scope';
import { HouseholdGamePoolService } from './household-game-pool.service';

/** Each type's ceiling is its own sentinel, so a where shows which ceiling clipped it. */
const ceilingOf = (type: string) => ({ id: `ceiling-${type}` });

/** The game pool the mocked count reports, in id order. */
const POOL = ['g-1', 'g-2', 'g-3', 'g-4', 'g-5', 'g-6', 'g-7'];

/**
 * #960. What the home page and its stats card show: a uniform sample of the
 * distinct games in the game pool of every live household the caller belongs
 * to, and how many there are.
 */
describe('HouseholdGamePoolService', () => {
  let service: HouseholdGamePoolService;
  let db: MockDatabaseService;
  // The transaction's own client, apart from `db`, so a read that escaped the
  // snapshot would land on `db` and show.
  let tx: MockDatabaseService;
  let abilityService: MockAbilityService;
  let compose: jest.SpyInstance;

  const sampleOf = (size = 10) => service.sampleGamePool(Object.assign(new RandomSampleQueryDto(), { size }));

  /** The where `compose` returned for its call on `type`. */
  const composedFor = (type: ResourceType) =>
    compose.mock.results[compose.mock.calls.findIndex(([called]) => called === type)]?.value as unknown;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockImplementation((type) => [ceilingOf(type)]);

    const ctx = await createTestingModuleWithDb({
      providers: [
        HouseholdGamePoolService,
        // The REAL composer, over the mocked ability service, so the where
        // clauses asserted below are the merge the sample actually runs.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    tx = createMockDatabaseService();
    db.$transaction.mockImplementation(((fn: (client: MockDatabaseService) => Promise<unknown>) => fn(tx)) as never);
    service = ctx.module.get(HouseholdGamePoolService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');

    tx.household.findMany.mockResolvedValue([{ id: 'hh-a' }, { id: 'hh-b' }] as never);
    tx.game.count.mockResolvedValue(POOL.length);
    // Reads as Prisma's cursor does: `skip` games on from the cursor's game,
    // or from the first game without one.
    tx.game.findFirst.mockImplementation((async (args: { skip: number; cursor?: { id: string } }) => {
      const id = POOL[(args.cursor ? POOL.indexOf(args.cursor.id) : 0) + args.skip];

      return id === undefined ? null : { id };
    }) as never);
  });

  afterEach(() => jest.clearAllMocks());

  // As `GET /households` reads them: live, and holding a membership.
  it("reads the caller's live households through the Household ceiling", async () => {
    await sampleOf();

    expect(compose).toHaveBeenCalledWith(ResourceType.Household, Action.read, {
      deletedAt: null,
      members: { some: { userId: MOCK_ACTING_USER_ID } },
    });
    expect(tx.household.findMany).toHaveBeenCalledWith({
      where: composedFor(ResourceType.Household),
      select: { id: true },
    });
  });

  // The game is the counted unit, so a game several members own is one game.
  // The game pool rule decides which entries count, under the GameCollection
  // ceiling; the Game ceiling keeps out a game the caller could not open.
  it('composes the game pool rule under the GameCollection ceiling, inside a game read under the Game ceiling', async () => {
    await sampleOf();

    expect(compose).toHaveBeenCalledWith(
      ResourceType.GameCollection,
      Action.read,
      gamePoolEntryScope(['hh-a', 'hh-b']),
    );
    expect(composedFor(ResourceType.GameCollection)).toEqual({
      ...gamePoolEntryScope(['hh-a', 'hh-b']),
      AND: [ceilingOf(ResourceType.GameCollection)],
    });
    expect(compose).toHaveBeenCalledWith(ResourceType.Game, Action.read, {
      deletedAt: null,
      platformGames: { some: { collections: { some: composedFor(ResourceType.GameCollection) } } },
    });
  });

  it('counts the game pool once and samples it through the same where, in one REPEATABLE READ transaction', async () => {
    const sample = await sampleOf(3);

    expect(db.$transaction.mock.calls[0][1 as never]).toEqual({
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
    expect(tx.game.count).toHaveBeenCalledWith({ where: composedFor(ResourceType.Game) });
    expect(tx.game.findFirst).toHaveBeenCalledTimes(3);
    for (const [args] of tx.game.findFirst.mock.calls) {
      expect(args).toEqual(
        expect.objectContaining({
          where: composedFor(ResourceType.Game),
          orderBy: { id: 'asc' },
          select: GAME_SUMMARY_SELECT,
        }),
      );
    }

    expect(sample.gameCount).toBe(POOL.length);
    expect(new Set(sample.games.map((game) => game.id)).size).toBe(3);
    expect(sample.games.every((game) => POOL.includes(game.id))).toBe(true);

    expect(db.household.findMany).not.toHaveBeenCalled();
    expect(db.game.count).not.toHaveBeenCalled();
    expect(db.game.findFirst).not.toHaveBeenCalled();
  });

  // A caller with no household. The stats card (client#614) shows its prompt
  // from this answer, so it is a sample, never a refusal. The Game where is
  // still composed, so the controller's scope guard holds.
  it('answers no games and a zero count when the caller belongs to no household, without reading games', async () => {
    tx.household.findMany.mockResolvedValue([] as never);

    expect(await sampleOf()).toEqual({ games: [], gameCount: 0 });
    expect(tx.game.count).not.toHaveBeenCalled();
    expect(tx.game.findFirst).not.toHaveBeenCalled();
    expect(compose).toHaveBeenCalledWith(ResourceType.Game, Action.read, expect.anything());
  });

  // PROVISIONAL (#395), as for `GET /households`: "my households" has no
  // meaning for an actor with no user behind it, and the refusal must never
  // soften into an empty sample, which would read as "no household".
  it('refuses an actor kind with no user behind it rather than answering an empty sample', async () => {
    abilityService.getActingUserId.mockImplementation(() => {
      throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
    });

    const rejection: unknown = await sampleOf().catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ForbiddenException);
    expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.access'));
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});
