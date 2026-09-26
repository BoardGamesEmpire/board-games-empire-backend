import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateWebhookSubscriptionDto } from './update-webhook-subscription.dto';

describe('UpdateWebhookSubscriptionDto', () => {
  const keysFor = async (plain: Record<string, unknown>) =>
    validationCatalogKeys(await validate(plainToInstance(UpdateWebhookSubscriptionDto, plain)));

  // Each failure must name a validation catalog key, so the edge can render it
  // in the request locale.
  describe('failure messages', () => {
    it('names a catalog key for every field failure', async () => {
      const keys = await keysFor({
        url: 'not a url',
        eventTypes: ['bogus.event.v1', 'bogus.event.v1'],
        secret: 42,
      });

      expect(keys).toEqual({
        'url.isUrl': 'validation.isUrl',
        'eventTypes.arrayUnique': 'validation.arrayUnique',
        'eventTypes.isIn': 'validation.each.isIn',
        'secret.isString': 'validation.isString',
        'secret.minLength': 'validation.minLength',
      });
    });

    it('names a catalog key for an empty event list', async () => {
      expect(await keysFor({ eventTypes: [] })).toEqual({ 'eventTypes.arrayNotEmpty': 'validation.arrayNotEmpty' });
    });

    it('accepts an empty patch — every field is optional', async () => {
      expect(await keysFor({})).toEqual({});
    });
  });
});
