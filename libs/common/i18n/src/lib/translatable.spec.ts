import { I18nMessage, isI18nMessage, t } from './translatable';

describe('translatable', () => {
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
