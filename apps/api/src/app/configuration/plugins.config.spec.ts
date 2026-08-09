import Joi from 'joi';
import { pluginsConfigValidationSchema } from './plugins.config';

interface PluginsEnvironment {
  PLUGINS_ROOT?: string;
  PLUGINS_BUNDLED_ROOT?: string;
}

const schema = Joi.object<PluginsEnvironment>(pluginsConfigValidationSchema);

const rootKeys = ['PLUGINS_ROOT', 'PLUGINS_BUNDLED_ROOT'] as const;

describe('pluginsConfigValidationSchema', () => {
  describe('optionality', () => {
    it('accepts a config with neither root set', () => {
      const { error } = schema.validate({});

      expect(error).toBeUndefined();
    });

    it.each(rootKeys)('accepts %s on its own', (key) => {
      const { error } = schema.validate({ [key]: '/var/lib/bge/plugins' });

      expect(error).toBeUndefined();
    });
  });

  describe('empty placeholders', () => {
    // `.env.example` ships `PLUGINS_ROOT=` and `PLUGINS_BUNDLED_ROOT=` empty:
    // that is the documented way to opt into the code defaults. `@bge/env` is
    // created with `allowEmptyString: false` and substitutes `defaultValue`,
    // but only if validation lets the empty value reach it — a bare
    // `Joi.string()` here rejects `''` and kills boot instead.
    it.each(rootKeys)('accepts %s as an empty string', (key) => {
      const { error } = schema.validate({ [key]: '' });

      expect(error).toBeUndefined();
    });

    it('accepts both roots empty, exactly as .env.example ships them', () => {
      const { error } = schema.validate({ PLUGINS_ROOT: '', PLUGINS_BUNDLED_ROOT: '' });

      expect(error).toBeUndefined();
    });

    it('passes the empty value through untouched rather than defaulting it here', () => {
      const { error, value } = schema.validate({ PLUGINS_ROOT: '' });

      expect(error).toBeUndefined();
      // Defaulting is @bge/env's job, not Joi's; asserting the passthrough keeps
      // the two layers from both trying to own it.
      expect(value.PLUGINS_ROOT).toBe('');
    });
  });

  describe('rejections', () => {
    it.each(rootKeys)('rejects a non-string %s', (key) => {
      const { error } = schema.validate({ [key]: 42 });

      expect(error).toBeDefined();
    });
  });
});
