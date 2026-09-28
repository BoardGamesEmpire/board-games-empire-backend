import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
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
      });

      expect(validationCatalogKeys(await validate(dto))).toEqual({
        'correlationId.isUuid': 'validation.isUUID',
        'query.isString': 'validation.isString',
        'gatewayIds.isArray': 'validation.isArray',
        'gatewayIds.isString': 'validation.each.isString',
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
