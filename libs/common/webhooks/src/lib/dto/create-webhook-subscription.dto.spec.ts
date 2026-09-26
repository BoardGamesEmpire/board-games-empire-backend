import { ResourceType } from '@bge/database';
import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WEBHOOK_EVENT_TYPES } from '../constants/webhook-event-types';
import { CreateWebhookSubscriptionDto } from './create-webhook-subscription.dto';

describe('CreateWebhookSubscriptionDto', () => {
  const keysFor = async (plain: Record<string, unknown>) =>
    validationCatalogKeys(await validate(plainToInstance(CreateWebhookSubscriptionDto, plain)));

  // Each failure must name a validation catalog key, so the edge can render it
  // in the request locale.
  describe('failure messages', () => {
    it('names a catalog key for every field failure', async () => {
      const keys = await keysFor({
        url: 'not a url',
        resourceType: 'NotAResource',
        eventTypes: ['bogus.event.v1', 'bogus.event.v1'],
        resourceId: 42,
        householdId: 42,
        secret: 42,
      });

      expect(keys).toEqual({
        'url.isUrl': 'validation.isUrl',
        'resourceType.isEnum': 'validation.isEnum',
        'eventTypes.arrayUnique': 'validation.arrayUnique',
        'eventTypes.isIn': 'validation.each.isIn',
        'resourceId.isString': 'validation.isString',
        'householdId.isString': 'validation.isString',
        'secret.isString': 'validation.isString',
        'secret.minLength': 'validation.minLength',
      });
    });

    it('names a catalog key for an empty event list', async () => {
      const keys = await keysFor({ url: 'https://example.com/hook', resourceType: ResourceType.Event, eventTypes: [] });

      expect(keys).toEqual({ 'eventTypes.arrayNotEmpty': 'validation.arrayNotEmpty' });
    });

    it('accepts a well-formed subscription', async () => {
      const keys = await keysFor({
        url: 'https://example.com/hook',
        resourceType: ResourceType.Event,
        eventTypes: [WEBHOOK_EVENT_TYPES[0]],
      });

      expect(keys).toEqual({});
    });
  });
});
