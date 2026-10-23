import { validationCatalogKeys } from '@bge/testing';
import { DECORATORS } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SearchQueryDto } from './search-query.dto';

describe('SearchQueryDto', () => {
  const toDto = (plain: Record<string, unknown>): SearchQueryDto => plainToInstance(SearchQueryDto, plain);

  // Mirror the GLOBAL ValidationPipe transformOptions from apps/api/src/main.ts.
  // enableImplicitConversion is the condition under which a naive boolean
  // (implicit Boolean() or @Type(() => Boolean)) silently turns 'false' into
  // true, so the boolean cases must be validated with it on.
  const toDtoWithPipe = (plain: Record<string, unknown>): SearchQueryDto =>
    plainToInstance(SearchQueryDto, plain, { enableImplicitConversion: true });

  describe('query', () => {
    it('accepts a valid query string', async () => {
      const dto = toDto({ query: 'Hades' });
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'query')).toHaveLength(0);
    });

    it('rejects when query is missing', async () => {
      const dto = toDto({});
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'query')).toBe(true);
    });

    it('rejects when query is not a string', async () => {
      const dto = toDto({ query: 123 });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'query')).toBe(true);
    });
  });

  describe('gatewayIds', () => {
    it('transforms a comma-separated string into an array', async () => {
      const dto = toDto({ query: 'test', gatewayIds: 'igdb-gw-1,bgg-gw-1' });
      expect(dto.gatewayIds).toEqual(['igdb-gw-1', 'bgg-gw-1']);
    });

    it('handles a single gateway ID string', async () => {
      const dto = toDto({ query: 'test', gatewayIds: 'igdb-gw-1' });
      expect(dto.gatewayIds).toEqual(['igdb-gw-1']);
    });

    it('filters out empty segments from trailing commas', async () => {
      const dto = toDto({ query: 'test', gatewayIds: 'igdb-gw-1,' });
      expect(dto.gatewayIds).toEqual(['igdb-gw-1']);
    });

    it('passes through an array unchanged', async () => {
      const dto = toDto({ query: 'test', gatewayIds: ['a', 'b'] });
      expect(dto.gatewayIds).toEqual(['a', 'b']);
    });

    it('is optional', async () => {
      const dto = toDto({ query: 'test' });
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'gatewayIds')).toHaveLength(0);
    });
  });

  describe('platformTypes and contentTypes', () => {
    const errorsOn = async (property: string, plain: Record<string, unknown>) =>
      (await validate(toDto({ query: 'test', ...plain }))).filter((e) => e.property === property);

    it('transform comma-separated stored names into lists', () => {
      const dto = toDto({ query: 'test', platformTypes: 'Tabletop,Portable,', contentTypes: 'BaseGame' });

      expect(dto.platformTypes).toEqual(['Tabletop', 'Portable']);
      expect(dto.contentTypes).toEqual(['BaseGame']);
    });

    it('take repeated parameters, splitting any that are comma-separated themselves', () => {
      expect(toDto({ query: 'test', platformTypes: ['PC', 'Arcade'] }).platformTypes).toEqual(['PC', 'Arcade']);
      expect(toDto({ query: 'test', platformTypes: ['Tabletop,PC', 'Mobile'] }).platformTypes).toEqual([
        'Tabletop',
        'PC',
        'Mobile',
      ]);
    });

    it('take values with spaces around them, as a hand-typed list has', async () => {
      const plain = { platformTypes: 'PC, Console', contentTypes: ['BaseGame ', ' DLC'] };

      expect(toDto({ query: 'test', ...plain })).toMatchObject({
        platformTypes: ['PC', 'Console'],
        contentTypes: ['BaseGame', 'DLC'],
      });
      await expect(errorsOn('platformTypes', plain)).resolves.toHaveLength(0);
      await expect(errorsOn('contentTypes', plain)).resolves.toHaveLength(0);
    });

    it('accept every stored platform type, and every content type but unknown', async () => {
      await expect(
        errorsOn('platformTypes', { platformTypes: 'Tabletop,Console,Portable,PC,Mobile,Arcade,Other' }),
      ).resolves.toHaveLength(0);
      await expect(errorsOn('contentTypes', { contentTypes: 'BaseGame,Expansion,DLC,Mod' })).resolves.toHaveLength(0);
    });

    it('refuse unknown, which names no kind of game, and a name the server does not store', async () => {
      await expect(errorsOn('contentTypes', { contentTypes: 'BaseGame,Unknown' })).resolves.toHaveLength(1);
      await expect(errorsOn('platformTypes', { platformTypes: 'PLATFORM_TYPE_TABLETOP' })).resolves.toHaveLength(1);
    });

    it('are optional', async () => {
      await expect(errorsOn('platformTypes', {})).resolves.toHaveLength(0);
      await expect(errorsOn('contentTypes', {})).resolves.toHaveLength(0);
    });
  });

  describe('includeLocal', () => {
    it('defaults to true', () => {
      const dto = new SearchQueryDto();
      expect(dto.includeLocal).toBe(true);
    });

    it('keeps the default when the param is absent', () => {
      expect(toDto({ query: 'test' }).includeLocal).toBe(true);
    });

    it('accepts a real false', async () => {
      const dto = toDto({ query: 'test', includeLocal: false });
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'includeLocal')).toHaveLength(0);
      expect(dto.includeLocal).toBe(false);
    });

    it("parses the query string 'false' as false", () => {
      expect(toDtoWithPipe({ query: 'test', includeLocal: 'false' }).includeLocal).toBe(false);
    });

    it("parses the query string 'true' as true", () => {
      expect(toDtoWithPipe({ query: 'test', includeLocal: 'true' }).includeLocal).toBe(true);
    });
  });

  describe('includeExternal', () => {
    it('defaults to true', () => {
      const dto = new SearchQueryDto();
      expect(dto.includeExternal).toBe(true);
    });

    it('keeps the default when the param is absent', () => {
      expect(toDto({ query: 'test' }).includeExternal).toBe(true);
    });

    it('accepts a real false', async () => {
      const dto = toDto({ query: 'test', includeExternal: false });
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'includeExternal')).toHaveLength(0);
      expect(dto.includeExternal).toBe(false);
    });

    it("parses the query string 'false' as false", () => {
      expect(toDtoWithPipe({ query: 'test', includeExternal: 'false' }).includeExternal).toBe(false);
    });
  });

  describe('limit', () => {
    it('is optional', async () => {
      const dto = toDto({ query: 'test' });
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'limit')).toHaveLength(0);
    });

    it('rejects values below 1', async () => {
      const dto = toDto({ query: 'test', limit: 0 });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'limit')).toBe(true);
    });

    it('rejects values above 100', async () => {
      const dto = toDto({ query: 'test', limit: 101 });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'limit')).toBe(true);
    });

    it('accepts values in the valid range', async () => {
      const dto = toDto({ query: 'test', limit: 50 });
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'limit')).toHaveLength(0);
    });

    it('transforms string numbers from query params', async () => {
      const dto = toDto({ query: 'test', limit: '25' });
      expect(dto.limit).toBe(25);
    });

    it('resolves the local page size to 20 when limit is absent', () => {
      expect(toDtoWithPipe({ query: 'test' }).pageSize).toBe(20);
    });

    it('resolves the local page size to limit when one is sent', () => {
      expect(toDtoWithPipe({ query: 'test', limit: '50' }).pageSize).toBe(50);
    });
  });

  describe('offset', () => {
    it('is optional', async () => {
      const dto = toDto({ query: 'test' });
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'offset')).toHaveLength(0);
    });

    it('rejects negative values', async () => {
      const dto = toDto({ query: 'test', offset: -1 });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === 'offset')).toBe(true);
    });

    it('accepts zero', async () => {
      const dto = toDto({ query: 'test', offset: 0 });
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'offset')).toHaveLength(0);
    });

    it('transforms string numbers from query params', async () => {
      const dto = toDto({ query: 'test', offset: '10' });
      expect(dto.offset).toBe(10);
    });
  });

  // A publish-year range narrows the search (#719): both bounds inclusive,
  // either may be left out, and a year before the common era is negative.
  describe('publish year', () => {
    const yearErrors = async (plain: Record<string, unknown>) =>
      validationCatalogKeys(
        (await validate(toDtoWithPipe({ query: 'x', ...plain }))).filter((e) => e.property.startsWith('publishYear')),
      );

    it('takes an inclusive publish-year range with either bound alone', async () => {
      await expect(yearErrors({ publishYearMin: 1990 })).resolves.toEqual({});
      await expect(yearErrors({ publishYearMax: -500 })).resolves.toEqual({});
      await expect(yearErrors({ publishYearMin: 1990, publishYearMax: 1990 })).resolves.toEqual({});
    });

    // Each bound travels as an int32, which wraps a larger one: 3000000000
    // would reach the DataGateways as a year near -1.3 billion.
    it('refuses a bound outside a 32-bit integer with validation.min or validation.max', async () => {
      await expect(yearErrors({ publishYearMin: '3000000000' })).resolves.toEqual({
        'publishYearMin.max': 'validation.max',
      });
      await expect(yearErrors({ publishYearMax: '-2147483649' })).resolves.toEqual({
        'publishYearMax.min': 'validation.min',
      });
      await expect(yearErrors({ publishYearMin: '-2147483648', publishYearMax: '2147483647' })).resolves.toEqual({});
    });

    it('reads its bounds from the query string as integers', () => {
      expect(toDtoWithPipe({ query: 'x', publishYearMin: '1990', publishYearMax: '-500' })).toMatchObject({
        publishYearMin: 1990,
        publishYearMax: -500,
      });
    });

    it('refuses a non-integer bound with validation.isInt', async () => {
      await expect(yearErrors({ publishYearMin: 1990.5 })).resolves.toEqual({
        'publishYearMin.isInt': 'validation.isInt',
      });
      // Not a number at all, so it's out of range too, as a non-numeric limit is.
      await expect(yearErrors({ publishYearMax: 'nineties' })).resolves.toEqual({
        'publishYearMax.isInt': 'validation.isInt',
        'publishYearMax.min': 'validation.min',
        'publishYearMax.max': 'validation.max',
      });
    });

    it('refuses a maximum below the minimum with validation.notLessThanProperty', async () => {
      await expect(yearErrors({ publishYearMin: 2000, publishYearMax: 1990 })).resolves.toEqual({
        'publishYearMax.notLessThanProperty': 'validation.notLessThanProperty',
      });
    });

    // Implicit conversion reads a blank as 0, a year like any other, so
    // `?publishYearMin=` would silently narrow from it.
    it('treats an empty publishYearMin as absent', async () => {
      const dto = toDtoWithPipe({ query: 'x', publishYearMin: '', publishYearMax: ' ' });

      expect(dto.publishYearMin).toBeUndefined();
      expect(dto.publishYearMax).toBeUndefined();
      await expect(yearErrors({ publishYearMin: '' })).resolves.toEqual({});
    });

    it('reads publishYearIncludeUnknown=false as false', () => {
      expect(toDtoWithPipe({ query: 'x', publishYearIncludeUnknown: 'false' }).publishYearIncludeUnknown).toBe(false);
      expect(toDtoWithPipe({ query: 'x', publishYearIncludeUnknown: 'true' }).publishYearIncludeUnknown).toBe(true);
    });

    // `boolean | null` is reflected as Object, which the published schema
    // would carry as an object reference rather than a boolean.
    it('publishes publishYearIncludeUnknown as a boolean in the OpenAPI schema', () => {
      expect(
        Reflect.getMetadata(DECORATORS.API_MODEL_PROPERTIES, SearchQueryDto.prototype, 'publishYearIncludeUnknown'),
      ).toMatchObject({ type: Boolean });
    });

    it('names a catalog key for a flag that is not a boolean', async () => {
      const dto = Object.assign(new SearchQueryDto(), { query: 'x', publishYearIncludeUnknown: 'yes' });

      expect(validationCatalogKeys(await validate(dto))).toEqual({
        'publishYearIncludeUnknown.isBoolean': 'validation.isBoolean',
      });
    });
  });

  // Each failure must name a validation catalog key, so the edge can render it
  // in the request locale. Assigned without the transformers: the
  // boolean transform coerces everything to a boolean, so only a raw value can
  // reach @IsBoolean.
  describe('failure messages', () => {
    it('names a catalog key for every field failure', async () => {
      const dto = Object.assign(new SearchQueryDto(), {
        query: 42,
        gatewayIds: 42,
        includeLocal: 'yes',
        includeExternal: 'yes',
        locale: 42,
        platformTypes: 42,
        contentTypes: 42,
      });

      expect(validationCatalogKeys(await validate(dto))).toEqual({
        'query.isString': 'validation.isString',
        'gatewayIds.isArray': 'validation.isArray',
        'gatewayIds.isString': 'validation.each.isString',
        'platformTypes.isArray': 'validation.isArray',
        'platformTypes.isIn': 'validation.each.isIn',
        'contentTypes.isArray': 'validation.isArray',
        'contentTypes.isIn': 'validation.each.isIn',
        'includeLocal.isBoolean': 'validation.isBoolean',
        'includeExternal.isBoolean': 'validation.isBoolean',
        'locale.isString': 'validation.isString',
      });
    });
  });

  describe('locale', () => {
    it('is optional', async () => {
      const dto = toDto({ query: 'test' });
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'locale')).toHaveLength(0);
    });

    it('accepts a valid locale string', async () => {
      const dto = toDto({ query: 'test', locale: 'de' });
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'locale')).toHaveLength(0);
      expect(dto.locale).toBe('de');
    });
  });
});
