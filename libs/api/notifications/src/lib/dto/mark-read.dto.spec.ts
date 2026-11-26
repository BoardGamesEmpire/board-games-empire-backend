import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import type { ValidatorOptions } from 'class-validator';
import { validate } from 'class-validator';
import { MAX_UNREAD_NOTIFICATIONS } from '../notifications.constants';
import { MarkReadDto } from './mark-read.dto';

/** The global I18nValidationPipe's validator options (see apps/api main.ts). */
const GLOBAL_PIPE_OPTIONS: ValidatorOptions = { whitelist: true, forbidNonWhitelisted: true };

// Transforms and validates as the global pipe does.
const errorsFor = (plain: Record<string, unknown>) =>
  validate(plainToInstance(MarkReadDto, plain, { enableImplicitConversion: true }), GLOBAL_PIPE_OPTIONS);

describe('MarkReadDto', () => {
  const keysFor = async (plain: Record<string, unknown>) => validationCatalogKeys(await errorsFor(plain));

  const constraintsFailed = async (plain: Record<string, unknown>) =>
    Object.fromEntries((await errorsFor(plain)).map((error) => [error.property, Object.keys(error.constraints ?? {})]));

  // Each failure must name a validation catalog key, so the edge can render it
  // in the request locale.
  describe('failure messages', () => {
    it('names a catalog key for every type failure', async () => {
      expect(await keysFor({ notificationIds: 42 })).toEqual({
        'notificationIds.isArray': 'validation.isArray',
        'notificationIds.arrayMaxSize': 'validation.arrayMaxSize',
        'notificationIds.isString': 'validation.each.isString',
      });
    });

    it('names a catalog key for more ids than the unread list returns (#584)', async () => {
      const notificationIds = Array.from({ length: MAX_UNREAD_NOTIFICATIONS + 1 }, (_, i) => `n-${i}`);

      expect(await keysFor({ notificationIds })).toEqual({
        'notificationIds.arrayMaxSize': 'validation.arrayMaxSize',
      });
    });
  });

  it('accepts as many ids as the unread list returns (#584)', async () => {
    const notificationIds = Array.from({ length: MAX_UNREAD_NOTIFICATIONS }, (_, i) => `n-${i}`);

    expect(await keysFor({ notificationIds })).toEqual({});
  });

  it('accepts notificationIds alone (#584)', async () => {
    expect(await keysFor({ notificationIds: ['n-1'] })).toEqual({});
  });

  it('accepts an empty list, which marks nothing rather than failing (#584)', async () => {
    expect(await keysFor({ notificationIds: [] })).toEqual({});
  });

  it("refuses a userId, which the route never read: it marks the acting user's own (#584)", async () => {
    expect(await constraintsFailed({ userId: 'user-1', notificationIds: ['n-1'] })).toEqual({
      userId: ['whitelistValidation'],
    });
  });
});
