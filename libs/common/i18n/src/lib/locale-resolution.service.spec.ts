import type { DatabaseService } from '@bge/database';
import { Logger } from '@nestjs/common';
import { LocaleResolutionService } from './locale-resolution.service';
import type { SupportedLocalesService } from './supported-locales.service';

const buildDb = (result: { tag: string } | null | Error): DatabaseService =>
  ({
    userPreferences: {
      findUnique:
        result instanceof Error
          ? jest.fn().mockRejectedValue(result)
          : jest.fn().mockResolvedValue(result === null ? null : { languageTag: result }),
    },
  }) as unknown as DatabaseService;

// Multi-locale supported set so precedence and fall-through are observable.
const supportedLocales = { getSupportedTags: () => ['en', 'de'] } as unknown as SupportedLocalesService;

const build = (prefResult: { tag: string } | null | Error): LocaleResolutionService =>
  new LocaleResolutionService(buildDb(prefResult), supportedLocales);

describe('LocaleResolutionService', () => {
  describe('user preference branch', () => {
    it('wins over Accept-Language when the preferred tag is supported', async () => {
      const service = build({ tag: 'de' });
      await expect(service.resolve({ userId: 'u1', acceptLanguage: 'en' })).resolves.toBe('de');
    });

    it('resolves a regional preference to its base catalog (RFC 4647 lookup)', async () => {
      const service = build({ tag: 'de-AT' });
      await expect(service.resolve({ userId: 'u1' })).resolves.toBe('de');
    });

    it('falls through to Accept-Language when the preferred tag is unsupported', async () => {
      const service = build({ tag: 'fr' });
      await expect(service.resolve({ userId: 'u1', acceptLanguage: 'de' })).resolves.toBe('de');
    });

    it('is skipped when the user has no preferences row', async () => {
      const service = build(null);
      await expect(service.resolve({ userId: 'u1', acceptLanguage: 'de' })).resolves.toBe('de');
    });

    it('is skipped when preferences carry no language tag', async () => {
      const service = new LocaleResolutionService(
        {
          userPreferences: { findUnique: jest.fn().mockResolvedValue({ languageTag: null }) },
        } as unknown as DatabaseService,
        supportedLocales,
      );
      await expect(service.resolve({ userId: 'u1', acceptLanguage: 'de' })).resolves.toBe('de');
    });

    it('falls through with a warning when the preference lookup fails', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const service = build(new Error('connection refused'));

      await expect(service.resolve({ userId: 'u1', acceptLanguage: 'de' })).resolves.toBe('de');
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });

    it('is not consulted without a userId', async () => {
      const db = buildDb({ tag: 'de' });
      const service = new LocaleResolutionService(db, supportedLocales);

      await expect(service.resolve({ acceptLanguage: 'de' })).resolves.toBe('de');
      expect(db.userPreferences.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('Accept-Language branch', () => {
    it('resolves a regional header range to its base catalog', async () => {
      const service = build(null);
      await expect(service.resolve({ userId: 'u1', acceptLanguage: 'de-CH' })).resolves.toBe('de');
    });

    it('respects quality ordering', async () => {
      const service = build(null);
      await expect(service.resolve({ userId: 'u1', acceptLanguage: 'de;q=0.5, en' })).resolves.toBe('en');
    });

    it('skips unsupported ranges', async () => {
      const service = build(null);
      await expect(service.resolve({ userId: 'u1', acceptLanguage: 'fr, de;q=0.3' })).resolves.toBe('de');
    });
  });

  describe('fallback branch', () => {
    it('falls back when nothing resolves', async () => {
      const service = build({ tag: 'fr' });
      await expect(service.resolve({ userId: 'u1', acceptLanguage: 'pt-BR' })).resolves.toBe('en');
    });

    it('falls back with no user and no header', async () => {
      const service = build(null);
      await expect(service.resolve({})).resolves.toBe('en');
    });
  });

  describe('preference cache', () => {
    let nowSpy: jest.SpyInstance;
    let now: number;

    beforeEach(() => {
      now = 1_000_000;
      nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    });

    afterEach(() => {
      nowSpy.mockRestore();
    });

    it('serves repeat lookups for a user from the cache within the TTL', async () => {
      const db = buildDb({ tag: 'de' });
      const service = new LocaleResolutionService(db, supportedLocales);

      await expect(service.resolve({ userId: 'u1' })).resolves.toBe('de');
      await expect(service.resolve({ userId: 'u1' })).resolves.toBe('de');

      expect(db.userPreferences.findUnique).toHaveBeenCalledTimes(1);
    });

    it('caches the absence of a preference too', async () => {
      const db = buildDb(null);
      const service = new LocaleResolutionService(db, supportedLocales);

      await service.resolve({ userId: 'u1', acceptLanguage: 'de' });
      await service.resolve({ userId: 'u1', acceptLanguage: 'de' });

      expect(db.userPreferences.findUnique).toHaveBeenCalledTimes(1);
    });

    it('re-queries once the TTL has elapsed', async () => {
      const db = buildDb({ tag: 'de' });
      const service = new LocaleResolutionService(db, supportedLocales);

      await service.resolve({ userId: 'u1' });
      now += LocaleResolutionService.PREFERENCE_TTL_MS + 1;
      await service.resolve({ userId: 'u1' });

      expect(db.userPreferences.findUnique).toHaveBeenCalledTimes(2);
    });

    it('serves the expired cached preference when the re-query fails', async () => {
      const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
      const findUnique = jest
        .fn()
        .mockResolvedValueOnce({ languageTag: { tag: 'de' } })
        .mockRejectedValueOnce(new Error('connection refused'));
      const db = { userPreferences: { findUnique } } as unknown as DatabaseService;
      const service = new LocaleResolutionService(db, supportedLocales);

      await expect(service.resolve({ userId: 'u1' })).resolves.toBe('de');
      now += LocaleResolutionService.PREFERENCE_TTL_MS + 1;
      await expect(service.resolve({ userId: 'u1' })).resolves.toBe('de');

      expect(findUnique).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalled();

      warnSpy.mockRestore();
    });
  });
});
