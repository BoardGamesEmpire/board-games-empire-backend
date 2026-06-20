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
