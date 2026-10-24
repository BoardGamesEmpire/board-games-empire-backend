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
