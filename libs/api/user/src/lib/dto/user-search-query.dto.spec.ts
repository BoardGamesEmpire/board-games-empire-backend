import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UserSearchQueryDto } from './user-search-query.dto';

describe('UserSearchQueryDto', () => {
  const keysFor = async (plain: Record<string, unknown>) =>
    validationCatalogKeys(await validate(plainToInstance(UserSearchQueryDto, plain)));

  // Each failure must name a validation catalog key, so the edge can render it
  // in the request locale.
  describe('failure messages', () => {
    it('names a catalog key for a non-string term', async () => {
      expect(await keysFor({ q: 42 })).toEqual({
        'q.isString': 'validation.isString',
        'q.minLength': 'validation.minLength',
      });
    });

    it('names a catalog key for a term below the minimum length', async () => {
      expect(await keysFor({ q: 'a' })).toEqual({ 'q.minLength': 'validation.minLength' });
    });

    it('accepts a term at the minimum length', async () => {
      expect(await keysFor({ q: 'ab' })).toEqual({});
    });
  });
});
