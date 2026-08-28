import { Prisma } from '@bge/database';
import { batchTransactionCall, createTestingModuleWithDb, MockDatabaseService } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { LanguageQueryDto } from './dto/language-query.dto';
import { LanguageService } from './language.service';

describe('LanguageService', () => {
  let service: LanguageService;
  let db: MockDatabaseService;

  beforeEach(async () => {
    const testing = await createTestingModuleWithDb({
      providers: [LanguageService],
    });

    db = testing.db;
    service = testing.module.get(LanguageService);
    db.language.findMany.mockResolvedValue([]);
    db.language.count.mockResolvedValue(0);
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });

  describe('getLanguages systemSupported filter', () => {
    const whereOf = () => db.language.findMany.mock.calls[0][0]?.where;

    it('omits the filter (undefined) when systemSupported is not provided', async () => {
      await service.getLanguages({} as LanguageQueryDto);
      expect(whereOf()?.tags).toBeUndefined();
    });

    it('requires a supported tag when systemSupported is true', async () => {
      await service.getLanguages({ systemSupported: true } as LanguageQueryDto);
      expect(whereOf()?.tags).toEqual({ some: { systemSupported: true } });
    });

    it('excludes languages with supported tags when systemSupported is false', async () => {
      await service.getLanguages({ systemSupported: false } as LanguageQueryDto);
      expect(whereOf()?.tags).toEqual({ none: { systemSupported: true } });
    });
  });

  describe('pagination envelope (#372)', () => {
    // Built through the DTO because `skip`/`pageSize` are derived accessors: a
    // literal would let this assert paging the DTO never computed.
    const query = (init: Partial<LanguageQueryDto> = {}) =>
      plainToInstance(LanguageQueryDto, init, { enableImplicitConversion: true });

    it('reads the rows and the count in one REPEATABLE READ transaction', async () => {
      await service.getLanguages(query());

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    // The filters are what make `total` meaningful here: a count that ignored
    // them would advertise pages of languages the filtered read never returns.
    it('counts through the same filtered where as the rows', async () => {
      db.language.count.mockResolvedValue(2);

      const page = await service.getLanguages(query({ name: 'eng', systemSupported: true }));

      expect(db.language.count).toHaveBeenCalledWith({
        where: {
          name: { contains: 'eng', mode: 'insensitive' },
          tags: { some: { systemSupported: true } },
        },
      });
      expect(page).toEqual({ rows: [], total: 2 });
    });

    // The DTO's own default (20, from CappedPaginationQueryDto(50, 20)) is what
    // `take` must resolve to — the service no longer holds a default of its own.
    it('takes the page size the DTO resolved, not a service-local default', async () => {
      await service.getLanguages(query({ page: 2 }));

      expect(db.language.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 20, skip: 20 }));
    });
  });
});
