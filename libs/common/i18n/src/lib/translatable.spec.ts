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
  });
});
