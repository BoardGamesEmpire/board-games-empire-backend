import { validationCatalogKeys } from '@bge/testing';
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
