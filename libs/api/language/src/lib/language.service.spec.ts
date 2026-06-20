import { createTestingModuleWithDb, MockDatabaseService } from '@bge/testing';
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
  });

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });

  describe('getLanguages systemSupported filter', () => {
    const whereOf = () => db.language.findMany.mock.calls[0][0]?.where;

    it('omits the filter (undefined) when systemSupported is not provided', async () => {
      await service.getLanguages({} as LanguageQueryDto);
      expect(whereOf()?.systemSupported).toBeUndefined();
    });

    it('filters on true when systemSupported is true', async () => {
      await service.getLanguages({ systemSupported: true } as LanguageQueryDto);
      expect(whereOf()?.systemSupported).toBe(true);
    });

    it('filters on false when systemSupported is false', async () => {
      await service.getLanguages({ systemSupported: false } as LanguageQueryDto);
      expect(whereOf()?.systemSupported).toBe(false);
    });
  });
});
