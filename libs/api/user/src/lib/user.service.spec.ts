import { Action, Prisma, ResourceType } from '@bge/database';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  type MockAbilityService,
  type MockDatabaseService,
} from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { UserSearchQueryDto } from './dto';
import { UserService } from './user.service';

/**
 * A bound `UserSearchQueryDto`. Built through the DTO rather than cast from a
 * literal because `skip`/`pageSize` are derived accessors (#230) — a literal
 * would let a test assert paging the DTO never computed.
 */
const searchQuery = (init: Partial<UserSearchQueryDto> = {}) =>
  plainToInstance(UserSearchQueryDto, { q: 'ada', ...init }, { enableImplicitConversion: true });

/** Stands in for the caller's `User` ceiling, so each assertion can tell it from the search's own clauses. */
const COND = { id: 'within-the-ceiling' };

/** Stands in for the caller's `UserProfile` ceiling. */
const PROFILE_COND = { id: 'within-the-profile-ceiling' };

describe('UserService', () => {
  let service: UserService;
  let db: MockDatabaseService;
  let abilityService: MockAbilityService;

  beforeEach(async () => {
    abilityService = createMockAbilityService();
    abilityService.getCurrentResourceConditions.mockImplementation((resourceType) =>
      resourceType === ResourceType.UserProfile ? [PROFILE_COND] : [COND],
    );

    const ctx = await createTestingModuleWithDb({
      providers: [
        UserService,
        // The REAL composer over the mocked ability service, so the where-clause
        // assertions below test the merge the search actually depends on.
        ScopeComposer,
        { provide: AbilityService, useValue: abilityService },
      ],
    });

    db = ctx.db;
    service = ctx.module.get(UserService);
    db.user.findMany.mockResolvedValue([]);
    db.user.count.mockResolvedValue(0);
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });

  describe('searchUsers', () => {
    it('excludes the caller, banned accounts and unsearchable profiles', async () => {
      await service.searchUsers('me', searchQuery());

      const where = db.user.findMany.mock.calls[0][0]?.where;
      expect(where?.AND).toEqual(
        expect.arrayContaining([
          { banned: false },
          { id: { not: 'me' } },
          { profile: { is: expect.objectContaining({ isSearchable: true }) } },
        ]),
      );
    });

    it('matches the term against username, first name and display name', async () => {
      await service.searchUsers('me', searchQuery({ q: 'ada' }));

      const where = db.user.findMany.mock.calls[0][0]?.where;
      expect(where?.AND).toEqual(
        expect.arrayContaining([
          {
            OR: [
              { username: { contains: 'ada', mode: 'insensitive' } },
              { firstName: { contains: 'ada', mode: 'insensitive' } },
              { profile: { displayName: { contains: 'ada', mode: 'insensitive' } } },
            ],
          },
        ]),
      );
    });

    // The search names its own set, and the caller's ceiling only clips it:
    // an API key pinned to one user narrows the page to that user.
    it("ANDs the caller's User read ceiling onto the search's own clauses", async () => {
      await service.searchUsers('me', searchQuery());

      const where = db.user.findMany.mock.calls[0][0]?.where;
      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.User, Action.read);
      expect(where?.AND).toHaveLength(5);
      expect(where?.AND).toEqual(expect.arrayContaining([COND, { banned: false }, { id: { not: 'me' } }]));
    });

    // Each row carries its profile's name and avatar, so the profile is read
    // too, and the caller's `UserProfile` ceiling clips the rows as well: a key
    // pinned to one profile is not served the others'.
    it("ANDs the caller's UserProfile read ceiling onto the profile each row carries", async () => {
      await service.searchUsers('me', searchQuery());

      const where = db.user.findMany.mock.calls[0][0]?.where;
      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.UserProfile, Action.read);
      expect(where?.AND).toEqual(
        expect.arrayContaining([{ profile: { is: { isSearchable: true, AND: [PROFILE_COND] } } }]),
      );
    });

    // One avatar, the profile's. The sign-in provider's picture only seeds it
    // at provisioning, so a row serving both would offer two pictures (#695).
    it("serves the profile's avatar and not the sign-in provider's picture", async () => {
      await service.searchUsers('me', searchQuery());

      const select = db.user.findMany.mock.calls[0][0]?.select;
      expect(select).not.toHaveProperty('image');
      expect(select?.profile).toEqual({ select: { displayName: true, avatarUrl: true } });
    });

    // #372: the count is the same text match a second time, so it has to carry
    // the same predicates — a `total` counting banned or unsearchable users
    // would advertise pages the filtered read never returns.
    it('counts through the same where as the rows', async () => {
      db.user.count.mockResolvedValue(31);

      const page = await service.searchUsers('me', searchQuery());

      expect(db.user.count).toHaveBeenCalledWith({ where: db.user.findMany.mock.calls[0][0]?.where });
      expect(page).toEqual({ rows: [], total: 31 });
    });

    it('reads the rows and the count in one REPEATABLE READ transaction', async () => {
      await service.searchUsers('me', searchQuery());

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    // The DTO's own default (10) and its 20-row cap are the contract; the
    // service holds no page size of its own since #230.
    it('takes the page size the DTO resolved, and skips by it', async () => {
      await service.searchUsers('me', searchQuery({ page: 3 }));

      expect(db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 10, skip: 20 }));
    });

    // `User.username` is `@unique`, which is what makes a single-key sort a
    // total order here — no tie-breaker needed, and none should be added.
    it('orders by the unique username, so pages cannot drift between requests', async () => {
      await service.searchUsers('me', searchQuery());

      expect(db.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ orderBy: { username: 'asc' } }));
    });
  });
});
