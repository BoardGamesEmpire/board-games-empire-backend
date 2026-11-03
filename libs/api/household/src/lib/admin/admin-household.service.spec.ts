import { Action, Prisma, Reach, ResourceType } from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createTestingModuleWithDb,
  unwrapTransaction,
  type MockDatabaseService,
} from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { ADMIN_HOUSEHOLD_ROW_SELECT } from '../read-shapes';
import { AdminHouseholdListQueryDto } from './admin-household-list.query.dto';
import { ADMIN_HOUSEHOLD_LIST_SCOPE, AdminHouseholdService } from './admin-household.service';

const CEILING = { id: 'sentinel-ceiling' };

/** What the real composer returns for an unscoped read over the mocked ceiling. */
const COMPOSED = { AND: [CEILING] };

const queryOf = (plain: Record<string, unknown> = {}) => plainToInstance(AdminHouseholdListQueryDto, plain);

/**
 * The staff households list's read (#419): every household on the server,
 * narrowed by `status` and `q`, in one of four orders, as a lean row.
 */
describe('AdminHouseholdService', () => {
  let service: AdminHouseholdService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<Pick<AbilityService, 'getCurrentResourceConditions'>>;
  let compose: jest.SpyInstance;

  beforeEach(async () => {
    abilityService = { getCurrentResourceConditions: jest.fn().mockReturnValue([CEILING]) };

    const ctx = await createTestingModuleWithDb({
      providers: [
        AdminHouseholdService,
        // The REAL composer, over the mocked ability service, as
        // household.service.spec.ts uses it: a double would make every
        // where-clause assertion below a test of the double.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    unwrapTransaction(db);
    db.household.findMany.mockResolvedValue([]);
    db.household.count.mockResolvedValue(0);

    service = ctx.module.get(AdminHouseholdService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');
  });

  afterEach(() => jest.clearAllMocks());

  const findManyArgs = () => db.household.findMany.mock.calls[0][0] as Prisma.HouseholdFindManyArgs;

  it('composes the household read ceiling over an explicitly unscoped list', async () => {
    await service.listHouseholds(queryOf());

    expect(compose).toHaveBeenCalledTimes(1);
    expect(compose).toHaveBeenCalledWith(ResourceType.Household, Action.read, ADMIN_HOUSEHOLD_LIST_SCOPE);
    expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Household, Action.read);
  });

  it.each([
    ['live', [COMPOSED, { deletedAt: null }]],
    ['deleted', [COMPOSED, { deletedAt: { not: null } }]],
    ['all', [COMPOSED]],
  ])('filters status=%s beside the ceiling', async (status, and) => {
    await service.listHouseholds(queryOf({ status }));

    expect(findManyArgs().where).toEqual({ AND: and });
  });

  // A name match and a member match on one household list it once: the
  // member half is a `some`, a filter on the household, never a join.
  it('matches q against the household name, or a member’s username or display name, with wildcards escaped', async () => {
    await service.listHouseholds(queryOf({ q: '50%_off' }));

    const pattern = '50\\%\\_off';
    const matches = { contains: pattern, mode: 'insensitive' };

    expect(findManyArgs().where).toEqual({
      AND: [
        COMPOSED,
        { deletedAt: null },
        {
          OR: [
            { name: matches },
            {
              members: {
                some: { user: { OR: [{ username: matches }, { profile: { displayName: matches } }] } },
              },
            },
          ],
        },
      ],
    });
  });

  it.each([
    ['name', 'live', [{ name: 'asc' }, { id: 'asc' }]],
    ['newest', 'live', [{ createdAt: 'desc' }, { id: 'desc' }]],
    ['members', 'live', [{ members: { _count: 'desc' } }, { id: 'desc' }]],
    ['deleted', 'all', [{ deletedAt: { sort: 'desc', nulls: 'last' } }, { id: 'desc' }]],
  ])('orders sort=%s and ends in the id', async (sort, status, orderBy) => {
    await service.listHouseholds(queryOf({ sort, status }));

    expect(findManyArgs().orderBy).toEqual(orderBy);
  });

  // #230: `total` is only trustworthy against the rows because both come
  // from one snapshot, and the mock resolves the batch at any isolation level.
  it('reads rows and count over one where, in one REPEATABLE READ batch', async () => {
    await service.listHouseholds(queryOf({ page: 3, limit: 10, status: 'deleted' }));

    const { operations, options } = batchTransactionCall(db);
    expect(operations).toHaveLength(2);
    expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

    const where = { AND: [COMPOSED, { deletedAt: { not: null } }] };
    expect(db.household.findMany).toHaveBeenCalledWith({
      where,
      select: ADMIN_HOUSEHOLD_ROW_SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      skip: 20,
      take: 10,
    });
    expect(db.household.count).toHaveBeenCalledWith({ where });
  });

  it('maps each row to memberCount and flat owners', async () => {
    const createdAt = new Date('2026-10-01T12:00:00Z');
    const deletedAt = new Date('2026-11-01T12:00:00Z');
    db.household.findMany.mockResolvedValue([
      {
        id: 'hh-1',
        name: 'Catan Night',
        image: 'https://example.test/hh-1.png',
        reach: Reach.Friends,
        createdAt,
        deletedAt,
        _count: { members: 4 },
        members: [
          { userId: 'u-1', user: { username: 'ann', profile: { displayName: 'Ann' } } },
          { userId: 'u-2', user: { username: 'bo', profile: { displayName: 'Bo B.' } } },
        ],
      },
    ] as never);
    db.household.count.mockResolvedValue(31);

    await expect(service.listHouseholds(queryOf({ status: 'all' }))).resolves.toEqual({
      rows: [
        {
          id: 'hh-1',
          name: 'Catan Night',
          image: 'https://example.test/hh-1.png',
          reach: Reach.Friends,
          createdAt,
          deletedAt,
          memberCount: 4,
          owners: [
            { userId: 'u-1', username: 'ann', displayName: 'Ann' },
            { userId: 'u-2', username: 'bo', displayName: 'Bo B.' },
          ],
        },
      ],
      total: 31,
    });
  });

  // `displayName` is the profile's value as stored, not the shown name: the
  // username is beside it, and the client decides how to name the owner.
  it('gives an owner with no profile, or no display name, displayName null', async () => {
    db.household.findMany.mockResolvedValue([
      {
        id: 'hh-1',
        name: 'Catan Night',
        image: null,
        reach: Reach.Private,
        createdAt: new Date(),
        deletedAt: null,
        _count: { members: 2 },
        members: [
          { userId: 'u-1', user: { username: 'ann', profile: null } },
          { userId: 'u-2', user: { username: 'bo', profile: { displayName: null } } },
        ],
      },
    ] as never);

    const { rows } = await service.listHouseholds(queryOf());

    expect(rows[0].owners).toEqual([
      { userId: 'u-1', username: 'ann', displayName: null },
      { userId: 'u-2', username: 'bo', displayName: null },
    ]);
  });
});
