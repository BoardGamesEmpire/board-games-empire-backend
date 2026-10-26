import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { toProtoSearchFilter } from '../search-filter';
import { SearchCancelDto, SearchStartDto } from './search-start.dto';

describe('SearchStartDto', () => {
  // The search gateway validates @MessageBody with enableImplicitConversion on
  // (apps/api/src/app/gateways/game/search.gateway.ts), so mirror that here.
  const toDto = (plain: Record<string, unknown>): SearchStartDto =>
    plainToInstance(SearchStartDto, plain, { enableImplicitConversion: true });

  const base = { correlationId: 'c1', query: 'Hades' };

  describe('includeLocal / includeExternal', () => {
    it('default to true when absent', () => {
      const dto = toDto(base);
      expect(dto.includeLocal).toBe(true);
      expect(dto.includeExternal).toBe(true);
    });

    it('accept real booleans from a JSON message body', () => {
      const dto = toDto({ ...base, includeLocal: false, includeExternal: false });
      expect(dto.includeLocal).toBe(false);
      expect(dto.includeExternal).toBe(false);
    });

    it("parse the string 'false' as false", () => {
      const dto = toDto({ ...base, includeLocal: 'false', includeExternal: 'false' });
      expect(dto.includeLocal).toBe(false);
      expect(dto.includeExternal).toBe(false);
    });
  });

  // REST splits a comma-separated list; a frame sends an array, so a string
  // here is a malformed frame and must not be split into one (#565).
  describe('gatewayIds', () => {
    it('refuses a comma-separated gatewayIds string', async () => {
      const dto = toDto({ ...base, gatewayIds: 'igdb-gw-1,bgg-gw-1' });

      expect(dto.gatewayIds).toBe('igdb-gw-1,bgg-gw-1');
      expect(validationCatalogKeys((await validate(dto)).filter((e) => e.property === 'gatewayIds'))).toEqual({
        'gatewayIds.isArray': 'validation.isArray',
      });
    });
  });

  // A publish-year range narrows the search (#719), as on REST.
  describe('publish year', () => {
    const yearErrors = async (plain: Record<string, unknown>) =>
      validationCatalogKeys(
        (await validate(toDto({ ...base, ...plain }))).filter((e) => e.property.startsWith('publishYear')),
      );

    it('takes an inclusive publish-year range with either bound alone', async () => {
      await expect(yearErrors({ publishYearMin: 1990 })).resolves.toEqual({});
      await expect(yearErrors({ publishYearMax: -500 })).resolves.toEqual({});
    });

    it('refuses a non-integer bound with validation.isInt', async () => {
      await expect(yearErrors({ publishYearMin: 1990.5 })).resolves.toEqual({
        'publishYearMin.isInt': 'validation.isInt',
      });
    });

    it('refuses a bound outside a 32-bit integer, which the proto would wrap', async () => {
      await expect(yearErrors({ publishYearMax: 2 ** 31 })).resolves.toEqual({
        'publishYearMax.max': 'validation.max',
      });
      await expect(yearErrors({ publishYearMin: -(2 ** 31) - 1 })).resolves.toEqual({
        'publishYearMin.min': 'validation.min',
      });
    });

    it('refuses a maximum below the minimum with validation.notLessThanProperty', async () => {
      await expect(yearErrors({ publishYearMin: 2000, publishYearMax: 1990 })).resolves.toEqual({
        'publishYearMax.notLessThanProperty': 'validation.notLessThanProperty',
      });
    });

    // A frame can send null, as it can for the lists, and null doesn't narrow.
    it('lets null through for each bound and the flag', async () => {
      const plain = { publishYearMin: null, publishYearMax: 2000, publishYearIncludeUnknown: null };

      await expect(yearErrors(plain)).resolves.toEqual({});
      expect(toProtoSearchFilter(toDto({ ...base, ...plain }))?.publishYear).toEqual({ max: 2000 });
    });

    // Implicit conversion would read false as 0 and true as 1, both real years.
    it('refuses a boolean or array bound rather than reading it as a year', async () => {
      await expect(yearErrors({ publishYearMin: false, publishYearMax: true })).resolves.toMatchObject({
        'publishYearMin.isInt': 'validation.isInt',
        'publishYearMax.isInt': 'validation.isInt',
      });
      await expect(yearErrors({ publishYearMin: [] })).resolves.toMatchObject({
        'publishYearMin.isInt': 'validation.isInt',
      });
    });

    it('reads an empty bound as absent rather than as year 0', () => {
      expect(toDto({ ...base, publishYearMin: '' }).publishYearMin).toBeUndefined();
    });
  });

  // Player-count and play-time ranges narrow the search (#869), as on REST.
  describe('player count and play time', () => {
    const rangeErrors = async (plain: Record<string, unknown>) =>
      validationCatalogKeys(
        (await validate(toDto({ ...base, ...plain }))).filter((e) => e.property.startsWith('play')),
      );

    it('takes a player count from 1 and a play time from 0 minutes', async () => {
      await expect(
        rangeErrors({ playerCountMin: 1, playerCountMax: 4, playTimeMin: 0, playTimeMax: 90 }),
      ).resolves.toEqual({});
      expect(toDto({ ...base, playTimeMin: '0' }).playTimeMin).toBe(0);
      await expect(rangeErrors({ playTimeMin: '0' })).resolves.toEqual({});
    });

    it('refuses a player count below 1 and a play time below 0 with validation.min', async () => {
      await expect(rangeErrors({ playerCountMin: '0' })).resolves.toEqual({
        'playerCountMin.min': 'validation.min',
      });
      await expect(rangeErrors({ playTimeMin: '-1' })).resolves.toEqual({
        'playTimeMin.min': 'validation.min',
      });
    });

    it('refuses a bound outside a 32-bit integer, which the proto would wrap', async () => {
      await expect(rangeErrors({ playerCountMax: 2 ** 31, playTimeMax: 2 ** 31 })).resolves.toEqual({
        'playerCountMax.max': 'validation.max',
        'playTimeMax.max': 'validation.max',
      });
    });

    it('refuses a maximum below the minimum with validation.notLessThanProperty', async () => {
      await expect(rangeErrors({ playerCountMin: '5', playerCountMax: '3' })).resolves.toEqual({
        'playerCountMax.notLessThanProperty': 'validation.notLessThanProperty',
      });
      await expect(rangeErrors({ playTimeMin: 90, playTimeMax: 60 })).resolves.toEqual({
        'playTimeMax.notLessThanProperty': 'validation.notLessThanProperty',
      });
    });

    // A frame can send null, as it can for the publish year, and null doesn't narrow.
    it('lets null through for each bound and flag', async () => {
      const nullMinimums = {
        playerCountMin: null,
        playerCountMax: 4,
        playerCountIncludeUnknown: null,
        playTimeMin: null,
        playTimeMax: 120,
        playTimeIncludeUnknown: null,
      };
      const nullMaximums = { playerCountMin: 2, playerCountMax: null, playTimeMin: 30, playTimeMax: null };

      await expect(rangeErrors(nullMinimums)).resolves.toEqual({});
      await expect(rangeErrors(nullMaximums)).resolves.toEqual({});
      expect(toProtoSearchFilter(toDto({ ...base, ...nullMinimums }))).toMatchObject({
        playerCount: { max: 4 },
        playTime: { max: 120 },
      });
      expect(toProtoSearchFilter(toDto({ ...base, ...nullMaximums }))).toMatchObject({
        playerCount: { min: 2 },
        playTime: { min: 30 },
      });
    });

    // Implicit conversion would read false as 0 and true as 1, a player count
    // and a play time like any other.
    it('refuses a boolean or array bound rather than reading it as a number', async () => {
      await expect(rangeErrors({ playerCountMin: true, playTimeMax: false })).resolves.toMatchObject({
        'playerCountMin.isInt': 'validation.isInt',
        'playTimeMax.isInt': 'validation.isInt',
      });
      await expect(rangeErrors({ playTimeMin: [] })).resolves.toMatchObject({
        'playTimeMin.isInt': 'validation.isInt',
      });
    });

    it('reads an empty bound as absent rather than as 0 minutes', () => {
      expect(toDto({ ...base, playTimeMax: '' }).playTimeMax).toBeUndefined();
      expect(toDto({ ...base, playerCountMin: '' }).playerCountMin).toBeUndefined();
    });
  });

  describe('pageSize', () => {
    it('resolves to 20 when limit is absent', () => {
      expect(toDto(base).pageSize).toBe(20);
    });

    it('resolves to limit when one is sent', () => {
      expect(toDto({ ...base, limit: 50 }).pageSize).toBe(50);
    });
  });

  // Each failure must name a validation catalog key, so the gateway's error
  // frame renders it in the connection's locale. Assigned without the
  // transformers: the boolean transform coerces everything to a boolean, so
  // only a raw value can reach @IsBoolean.
  describe('failure messages', () => {
    it('names a catalog key for every field failure, inherited paging included', async () => {
      const dto = Object.assign(new SearchStartDto(), {
        correlationId: 'not-a-uuid',
        query: 42,
        gatewayIds: 42,
        includeLocal: 'yes',
        includeExternal: 'yes',
        locale: 42,
        limit: 'x',
        offset: 'x',
        platformTypes: 42,
        contentTypes: ['Unknown'],
      });

      expect(validationCatalogKeys(await validate(dto))).toEqual({
        'correlationId.isUuid': 'validation.isUUID',
        'query.isString': 'validation.isString',
        'gatewayIds.isArray': 'validation.isArray',
        'gatewayIds.isString': 'validation.each.isString',
        'platformTypes.isArray': 'validation.isArray',
        'platformTypes.isIn': 'validation.each.isIn',
        'contentTypes.isIn': 'validation.each.isIn',
        'includeLocal.isBoolean': 'validation.isBoolean',
        'includeExternal.isBoolean': 'validation.isBoolean',
        'locale.isString': 'validation.isString',
        'limit.isInt': 'validation.isInt',
        'limit.isPositive': 'validation.isPositive',
        'limit.max': 'validation.max',
        'offset.isInt': 'validation.isInt',
        'offset.min': 'validation.min',
        'offset.max': 'validation.max',
      });
    });
  });
});

describe('SearchCancelDto', () => {
  it('names a catalog key for a bad correlationId', async () => {
    const dto = Object.assign(new SearchCancelDto(), { correlationId: 'not-a-uuid' });

    expect(validationCatalogKeys(await validate(dto))).toEqual({
      'correlationId.isUuid': 'validation.isUUID',
    });
  });
});
