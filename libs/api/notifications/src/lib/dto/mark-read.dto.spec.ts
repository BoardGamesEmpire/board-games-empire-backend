import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MarkReadDto } from './mark-read.dto';

describe('MarkReadDto', () => {
  const keysFor = async (plain: Record<string, unknown>) =>
    validationCatalogKeys(await validate(plainToInstance(MarkReadDto, plain)));

  // Each failure must name a validation catalog key, so the edge can render it
  // in the request locale.
  describe('failure messages', () => {
    it('names a catalog key for every type failure', async () => {
      expect(await keysFor({ userId: 42, notificationIds: 42 })).toEqual({
        'userId.isString': 'validation.isString',
        'notificationIds.isArray': 'validation.isArray',
        'notificationIds.isString': 'validation.each.isString',
      });
    });

    it('names a catalog key for an empty user id', async () => {
      expect(await keysFor({ userId: '', notificationIds: [] })).toEqual({
        'userId.isNotEmpty': 'validation.isNotEmpty',
      });
    });

    it('accepts a well-formed request', async () => {
      expect(await keysFor({ userId: 'user-1', notificationIds: ['n-1'] })).toEqual({});
    });
  });
});
