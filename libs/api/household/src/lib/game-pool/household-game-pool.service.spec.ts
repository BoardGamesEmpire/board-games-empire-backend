import { Action, GAME_SUMMARY_SELECT, Prisma, Reach, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import { RandomSampleQueryDto } from '@bge/shared';
import type { MockAbilityService, MockDatabaseService } from '@bge/testing';
import {
  createMockAbilityService,
  createMockDatabaseService,
  createTestingModuleWithDb,
  MOCK_ACTING_USER_ID,
  paginationQuery,
} from '@bge/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ACTOR_SELECT } from '../read-shapes';
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
    tx.game.findFirst.mockImplementation((async (args: { cursor?: { id: string }; skip: number }) => {
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

  /**
   * #367. One household's game pool, a page at a time: one row per game, each
   * naming the members whose readable entries put it there.
   */
  describe('listGamePool', () => {
    const HOUSEHOLD_ID = 'hh-a';
    const PAGE = paginationQuery({ page: 2, limit: 2 });

    const gameOf = (id: string, title: string) => ({ id, title, thumbnail: null, description: null });

    const userOf = (id: string, displayName: string | null, username = `user-${id}`) => ({
      id,
      username,
      profile: { avatarUrl: null, displayName },
    });

    const entryOf = (id: string, user: ReturnType<typeof userOf>, gameId: string, platform = 'pc') => ({
      id,
      user,
      platformGame: { gameId, platform: { id: `platform-${platform}`, name: platform.toUpperCase() } },
    });

    const listOf = () => service.listGamePool(HOUSEHOLD_ID, PAGE);

    beforeEach(() => {
      tx.household.findFirst.mockResolvedValue({ id: HOUSEHOLD_ID } as never);
      tx.game.count.mockResolvedValue(5);
      tx.game.findMany.mockResolvedValue([gameOf('g-1', 'Azul'), gameOf('g-2', 'Catan')] as never);
      tx.gameCollection.findMany.mockResolvedValue([]);
      tx.householdMember.findMany.mockResolvedValue([]);
    });

    // The game pool reach is a door, not a grant: it lets a friend of a
    // member in when it is `Friends`, and the Household read ceiling still
    // decides whether they may read the household at all. A household with no
    // settings row matches no `settings` clause, so it reads as `Private`.
    it('opens the household to its members, or to the Household ceiling when its game pool reach is Friends (#367)', async () => {
      await listOf();

      expect(compose).toHaveBeenCalledWith(ResourceType.Household, Action.read, {
        id: HOUSEHOLD_ID,
        deletedAt: null,
        OR: [
          { members: { some: { userId: MOCK_ACTING_USER_ID } } },
          { settings: { is: { gamePoolReach: Reach.Friends } } },
        ],
      });
      expect(tx.household.findFirst).toHaveBeenCalledWith({
        where: composedFor(ResourceType.Household),
        select: { id: true },
      });
    });

    // As `GET /households/:id` answers: a household the caller may not open
    // is 403 when it exists, and 404 when it does not, and nothing is read.
    it('refuses a household that exists but is closed to the caller with 403 (#367)', async () => {
      tx.household.findFirst.mockResolvedValue(null);
      tx.household.count.mockResolvedValue(1);

      const rejection: unknown = await listOf().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.view'));
      expect(tx.household.count).toHaveBeenCalledWith({ where: { id: HOUSEHOLD_ID, deletedAt: null } });
      expect(tx.game.count).not.toHaveBeenCalled();
      expect(tx.game.findMany).not.toHaveBeenCalled();
      expect(tx.gameCollection.findMany).not.toHaveBeenCalled();
    });

    it('answers 404 for a household that does not exist, or is deleted (#367)', async () => {
      tx.household.findFirst.mockResolvedValue(null);
      tx.household.count.mockResolvedValue(0);

      const rejection: unknown = await listOf().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(NotFoundException);
      expect((rejection as NotFoundException).getResponse()).toEqual(
        t('errors.household.not_found', { id: HOUSEHOLD_ID }),
      );
      expect(tx.game.findMany).not.toHaveBeenCalled();
    });

    // The game is the row, so a game several members own is one row. The game
    // pool rule for this one household decides which entries count, under the
    // GameCollection ceiling; the Game ceiling keeps out a game the caller
    // could not open at `GET /games/:id`.
    it("composes this household's game pool rule under the GameCollection ceiling, inside a game read under the Game ceiling (#367)", async () => {
      await listOf();

      expect(compose).toHaveBeenCalledWith(
        ResourceType.GameCollection,
        Action.read,
        gamePoolEntryScope([HOUSEHOLD_ID]),
      );
      expect(composedFor(ResourceType.GameCollection)).toEqual({
        ...gamePoolEntryScope([HOUSEHOLD_ID]),
        AND: [ceilingOf(ResourceType.GameCollection)],
      });
      expect(compose).toHaveBeenCalledWith(ResourceType.Game, Action.read, {
        deletedAt: null,
        platformGames: { some: { collections: { some: composedFor(ResourceType.GameCollection) } } },
      });
    });

    // `total` counts games, not entries, and two games with the same title
    // page the same way on every read: title, then id.
    it('counts and pages the games through one Game where, by title then id, in one REPEATABLE READ transaction (#367)', async () => {
      const page = await listOf();

      expect(db.$transaction.mock.calls[0][1 as never]).toEqual({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      });
      expect(tx.game.count).toHaveBeenCalledWith({ where: composedFor(ResourceType.Game) });
      expect(tx.game.findMany).toHaveBeenCalledWith({
        where: composedFor(ResourceType.Game),
        select: GAME_SUMMARY_SELECT,
        orderBy: [{ title: 'asc' }, { id: 'asc' }],
        skip: PAGE.skip,
        take: PAGE.pageSize,
      });
      expect(page.total).toBe(5);
      expect(page.rows.map((row) => row.id)).toEqual(['g-1', 'g-2']);

      expect(db.household.findFirst).not.toHaveBeenCalled();
      expect(db.game.count).not.toHaveBeenCalled();
      expect(db.game.findMany).not.toHaveBeenCalled();
      expect(db.gameCollection.findMany).not.toHaveBeenCalled();
      expect(db.householdMember.findMany).not.toHaveBeenCalled();
    });

    // The owners come from the same entries where the games were counted
    // through, so an entry its owner excluded, or one the caller can't read,
    // names no owner: a game two members own, one of whom excluded it, lists
    // only the other.
    it("reads the page's owners through the same entries where, in the same transaction (#367)", async () => {
      await listOf();

      expect(tx.gameCollection.findMany).toHaveBeenCalledWith({
        where: {
          AND: [composedFor(ResourceType.GameCollection), { platformGame: { gameId: { in: ['g-1', 'g-2'] } } }],
        },
        select: {
          id: true,
          user: { select: ACTOR_SELECT },
          platformGame: { select: { gameId: true, platform: { select: { id: true, name: true } } } },
        },
      });
    });

    // One owner per readable entry: a member owning a game on two platforms
    // appears twice. Owners are in shown-name order, then entry id, so a
    // client lists them the same way on every read.
    it('names one owner per entry, with their membership, in shown-name then entry-id order (#367)', async () => {
      const zoe = userOf('u-zoe', 'Zoe');
      const ana = userOf('u-ana', null, 'ana');
      tx.gameCollection.findMany.mockResolvedValue([
        entryOf('e-3', zoe, 'g-1'),
        entryOf('e-2', ana, 'g-1', 'switch'),
        entryOf('e-1', ana, 'g-1'),
        entryOf('e-4', zoe, 'g-2'),
      ] as never);
      tx.householdMember.findMany.mockResolvedValue([
        { id: 'm-zoe', userId: 'u-zoe' },
        { id: 'm-ana', userId: 'u-ana' },
      ] as never);

      const page = await listOf();

      expect(tx.householdMember.findMany).toHaveBeenCalledWith({
        where: { householdId: HOUSEHOLD_ID, userId: { in: ['u-zoe', 'u-ana'] } },
        select: { id: true, userId: true },
      });
      expect(page.rows).toEqual([
        {
          ...gameOf('g-1', 'Azul'),
          owners: [
            { memberId: 'm-ana', user: ana, collectionEntryId: 'e-1', platform: { id: 'platform-pc', name: 'PC' } },
            {
              memberId: 'm-ana',
              user: ana,
              collectionEntryId: 'e-2',
              platform: { id: 'platform-switch', name: 'SWITCH' },
            },
            { memberId: 'm-zoe', user: zoe, collectionEntryId: 'e-3', platform: { id: 'platform-pc', name: 'PC' } },
          ],
        },
        {
          ...gameOf('g-2', 'Catan'),
          owners: [
            { memberId: 'm-zoe', user: zoe, collectionEntryId: 'e-4', platform: { id: 'platform-pc', name: 'PC' } },
          ],
        },
      ]);
    });

    // Two members can share a shown name. Ordering by membership before entry
    // id keeps each member's entries side by side, so a client never lists
    // one member, then the other, then the first again (#367).
    it("keeps one member's entries together when two members share a shown name (#367)", async () => {
      const samA = userOf('u-sam-a', 'Sam');
      const samB = userOf('u-sam-b', 'Sam');
      tx.gameCollection.findMany.mockResolvedValue([
        entryOf('e-1', samB, 'g-1'),
        entryOf('e-2', samA, 'g-1'),
        entryOf('e-3', samB, 'g-1', 'switch'),
      ] as never);
      tx.householdMember.findMany.mockResolvedValue([
        { id: 'm-sam-a', userId: 'u-sam-a' },
        { id: 'm-sam-b', userId: 'u-sam-b' },
      ] as never);

      const page = await listOf();

      expect(page.rows[0]?.owners.map((owner) => [owner.memberId, owner.collectionEntryId])).toEqual([
        ['m-sam-a', 'e-2'],
        ['m-sam-b', 'e-1'],
        ['m-sam-b', 'e-3'],
      ]);
    });

    // A page past the end reads no owners: there are no games to name them for.
    it('answers an empty page without reading owners (#367)', async () => {
      tx.game.findMany.mockResolvedValue([]);

      expect(await listOf()).toEqual({ rows: [], total: 5 });
      expect(tx.gameCollection.findMany).not.toHaveBeenCalled();
      expect(tx.householdMember.findMany).not.toHaveBeenCalled();
    });

    // PROVISIONAL (#395), as for the game pool sample: a game pool is opened
    // by membership or friendship, which an actor with no user has neither of.
    it('refuses an actor kind with no user behind it (#367)', async () => {
      abilityService.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });

      const rejection: unknown = await listOf().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.access'));
      expect(db.$transaction).not.toHaveBeenCalled();
    });
  });
});
