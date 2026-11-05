import Joi from 'joi';
import { pluginsConfigValidationSchema } from './plugins.config';

interface PluginsEnvironment {
  PLUGINS_ROOT?: string;
}

const schema = Joi.object<PluginsEnvironment>(pluginsConfigValidationSchema);

describe('pluginsConfigValidationSchema', () => {
  it('declares PLUGINS_ROOT as its only variable: there is one plugin root (#696)', () => {
    // No plugin ships inside the server, so the root plugins are installed
    // into is the only plugin directory there is.
    expect(Object.keys(pluginsConfigValidationSchema)).toEqual(['PLUGINS_ROOT']);
  });

  describe('optionality', () => {
    it('accepts a config with no plugin root set (#259)', () => {
      const { error } = schema.validate({});

      expect(error).toBeUndefined();
    });

    it('accepts PLUGINS_ROOT set to a path (#259)', () => {
      const { error } = schema.validate({ PLUGINS_ROOT: '/var/lib/bge/plugins' });

      expect(error).toBeUndefined();
    });
  });

  describe('empty placeholder', () => {
    // `.env.example` ships `PLUGINS_ROOT=` empty: that is the documented way to
    // opt into the code defaults. `@bge/env` is created with
    // `allowEmptyString: false` and substitutes `defaultValue`, but only if
    // validation lets the empty value reach it — a bare `Joi.string()` here
    // rejects `''` and kills boot instead.
    it('accepts PLUGINS_ROOT as an empty string, exactly as .env.example ships it (#259)', () => {
      const { error } = schema.validate({ PLUGINS_ROOT: '' });

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
    it('rejects a non-string PLUGINS_ROOT (#259)', () => {
      const { error } = schema.validate({ PLUGINS_ROOT: 42 });

      expect(error).toBeDefined();
    });
  });
});
