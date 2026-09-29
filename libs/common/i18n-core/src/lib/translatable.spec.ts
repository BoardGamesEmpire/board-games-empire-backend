import { ForbiddenException } from '@nestjs/common';
import Keyv from 'keyv';
import { I18nMessage, isI18nMessage, t } from './translatable';

describe('translatable', () => {
  describe('a Nest exception built from a marker', () => {
    it("names the marker's key and args in its message and stack, where no edge translates it", () => {
      const refused = new ForbiddenException(
        t('errors.gateway_registry.auth_type_not_implemented', { authType: 'Bearer' }),
      );

      expect(refused.message).toBe('errors.gateway_registry.auth_type_not_implemented {"authType":"Bearer"}');
      expect(refused.stack?.split('\n')[0]).toBe(
        'ForbiddenException: errors.gateway_registry.auth_type_not_implemented {"authType":"Bearer"}',
      );
    });

    it('names the key alone when the marker has no args, or empty ones', () => {
      expect(new ForbiddenException(t('common.forbidden.action')).message).toBe('common.forbidden.action');
      expect(new ForbiddenException(t('common.forbidden.action', {})).message).toBe('common.forbidden.action');
    });

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    it.each([
      ['a BigInt', { id: 42n }],
      ['a circular reference', circular],
    ])('is still built, with its own status, when its args hold %s', (_, args) => {
      const refused = new ForbiddenException(t('errors.language.not_found', args));

      expect(refused.getStatus()).toBe(403);
      expect(refused.message).toBe('errors.language.not_found [unserializable args]');
    });
  });

  describe('serialized shape', () => {
    // A marker in a success body is serialized into the response cache and
    // recognized again on a hit by its brand, key and args. The message a Nest
    // exception reads must not be written beside them.
    const serialized = { __i18nMessage: true, key: 'errors.language.not_found', args: { id: '42' } };

    it('is the brand, key and args, in JSON', () => {
      expect(JSON.parse(JSON.stringify(t('errors.language.not_found', { id: '42' })))).toStrictEqual(serialized);
    });

    it('is the brand, key and args, as the response cache writes it through Keyv', async () => {
      const store = new Map<string, string>();

      await new Keyv({ store }).set('body', { notice: t('errors.language.not_found', { id: '42' }) });

      expect([...store.values()].map((entry) => JSON.parse(entry))).toStrictEqual([{ value: { notice: serialized } }]);
    });
  });

  describe('t', () => {
    it('builds an I18nMessage carrying the key and args', () => {
      const message = t('errors.language.not_found', { id: '42' });

      expect(message).toBeInstanceOf(I18nMessage);
      expect(message.key).toBe('errors.language.not_found');
      expect(message.args).toEqual({ id: '42' });
    });

    it('allows a key with no args', () => {
      expect(t('common.at_least_one_field').args).toBeUndefined();
    });
  });

  describe('isI18nMessage', () => {
    it('narrows I18nMessage instances', () => {
      expect(isI18nMessage(t('common.at_least_one_field'))).toBe(true);
    });

    it('rejects look-alikes and primitives', () => {
      expect(isI18nMessage({ key: 'common.at_least_one_field' })).toBe(false);
      expect(isI18nMessage('common.at_least_one_field')).toBe(false);
      expect(isI18nMessage(null)).toBe(false);
      expect(isI18nMessage(undefined)).toBe(false);
    });

    it('rejects a branded object without a usable string key', () => {
      // The brand alone must not qualify — `key` is dereferenced downstream, so
      // an object merely carrying `__i18nMessage: true` (or a non-string key) is
      // not a marker. Literal brand pins the serialized wire shape on purpose.
      expect(isI18nMessage({ __i18nMessage: true })).toBe(false);
      expect(isI18nMessage({ __i18nMessage: true, key: 42 })).toBe(false);
      expect(isI18nMessage({ __i18nMessage: 'yes', key: 'errors.language.not_found' })).toBe(false);
    });

    it('requires an own brand, not an inherited one', () => {
      const inherited = Object.create({ __i18nMessage: true });
      inherited.key = 'errors.language.not_found';
      expect(isI18nMessage(inherited)).toBe(false);
    });

    it('still narrows a marker rehydrated from JSON (response-cache round-trip)', () => {
      // A marker embedded in a cached success body comes back from Valkey as a
      // prototype-less plain object, so `instanceof` would miss it. The
      // serializable brand keeps it recognizable; key/args survive too.
      const rehydrated = JSON.parse(JSON.stringify(t('errors.language.not_found', { id: '42' })));

      expect(rehydrated).not.toBeInstanceOf(I18nMessage);
      expect(isI18nMessage(rehydrated)).toBe(true);
      expect(rehydrated.key).toBe('errors.language.not_found');
      expect(rehydrated.args).toEqual({ id: '42' });
    });
  });
});
