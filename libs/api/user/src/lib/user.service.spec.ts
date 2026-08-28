import { Prisma } from '@bge/database';
import { batchTransactionCall, createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
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

describe('UserService', () => {
  let service: UserService;
  let db: MockDatabaseService;

  beforeEach(async () => {
    const ctx = await createTestingModuleWithDb({
      providers: [UserService],
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
        expect.arrayContaining([{ banned: false }, { id: { not: 'me' } }, { profile: { isSearchable: true } }]),
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
