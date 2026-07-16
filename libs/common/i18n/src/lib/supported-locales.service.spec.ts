import type { DatabaseService } from '@bge/database';
import { Logger } from '@nestjs/common';
import type { I18nService } from 'nestjs-i18n';
import { FALLBACK_LOCALE } from './locale.constants';
import { SupportedLocalesService } from './supported-locales.service';

const buildDb = (tagsOrError: string[] | Error): DatabaseService =>
  ({
    languageTag: {
      findMany:
        tagsOrError instanceof Error
          ? jest.fn().mockRejectedValue(tagsOrError)
          : jest.fn().mockResolvedValue(tagsOrError.map((tag) => ({ tag }))),
    },
  }) as unknown as DatabaseService;

const buildI18n = (catalogs: string[]): I18nService =>
  ({ getSupportedLanguages: jest.fn().mockReturnValue(catalogs) }) as unknown as I18nService;

describe('SupportedLocalesService', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation();
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  const init = async (dbTags: string[] | Error, catalogs: string[]): Promise<SupportedLocalesService> => {
    const service = new SupportedLocalesService(buildDb(dbTags), buildI18n(catalogs));
    await service.onModuleInit();
    return service;
  };

  it(`defaults to ['${FALLBACK_LOCALE}'] before init`, () => {
    const service = new SupportedLocalesService(buildDb([]), buildI18n([]));
    expect(service.getSupportedTags()).toEqual([FALLBACK_LOCALE]);
  });

  it('exposes the aligned set without warnings', async () => {
    const service = await init(['de', 'en'], ['en', 'de']);
    expect(service.getSupportedTags()).toEqual(['de', 'en']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('matches catalog folders to DB tags case-insensitively, keeping DB casing', async () => {
    const service = await init(['en', 'pt-BR'], ['en', 'pt-br']);
    expect(service.getSupportedTags()).toEqual(['en', 'pt-BR']);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('fails the boot when the fallback catalog itself is missing', async () => {
    await expect(init(['de'], ['de'])).rejects.toThrow(
      new RegExp(`fallback locale '${FALLBACK_LOCALE}' has no loaded catalog`, 'i'),
    );
  });

  it('excludes db tags shipping no catalog and warns', async () => {
    const service = await init(['en', 'fr'], ['en']);
    expect(service.getSupportedTags()).toEqual(['en']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fr'));
  });

  it('warns about shipped catalogs not flagged systemSupported', async () => {
    const service = await init(['en'], ['en', 'de']);
    expect(service.getSupportedTags()).toEqual(['en']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('de'));
  });

  it(`always includes '${FALLBACK_LOCALE}' when the db flags other locales but not the fallback`, async () => {
    const service = await init(['de', 'fr'], ['en', 'de', 'fr']);
    expect(service.getSupportedTags()).toEqual([FALLBACK_LOCALE, 'de', 'fr']);
    // The fallback catalog is always reachable, so it is not reported unreachable.
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining(FALLBACK_LOCALE));
  });

  it(`falls back to ['${FALLBACK_LOCALE}'] when the sets do not intersect`, async () => {
    const service = await init(['fr'], ['en']);
    expect(service.getSupportedTags()).toEqual([FALLBACK_LOCALE]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No usable supported locales'));
  });

  it(`falls back to ['${FALLBACK_LOCALE}'] when the db query fails`, async () => {
    const service = await init(new Error('connection refused'), ['en']);
    expect(service.getSupportedTags()).toEqual([FALLBACK_LOCALE]);
    expect(errorSpy).toHaveBeenCalled();
  });
});
