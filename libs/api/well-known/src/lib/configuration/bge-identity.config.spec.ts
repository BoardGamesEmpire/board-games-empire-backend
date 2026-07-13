import Joi from 'joi';
import { bgeIdentityConfigValidationSchema } from './bge-identity.config';

const schema = Joi.object(bgeIdentityConfigValidationSchema);

describe('bgeIdentityConfigValidationSchema', () => {
  describe('client version bounds', () => {
    it('accepts an unset config (both bounds optional)', () => {
      const { error } = schema.validate({});

      expect(error).toBeUndefined();
    });

    it.each(['', '0.1.0', '1.2.3', '0.1.0-alpha.3', '1.2.3+build.5', '2.0.0-rc.1+exp.sha.5114f85'])(
      'accepts %p as a valid bound',
      (value) => {
        const { error } = schema.validate({ BGE_MIN_CLIENT_VERSION: value, BGE_MAX_CLIENT_VERSION: value });

        expect(error).toBeUndefined();
      },
    );

    it.each(['latest', 'v1', '1', '1.2', '1.2.x', 'not-a-version'])('rejects %p as a bound', (value) => {
      const { error } = schema.validate({ BGE_MIN_CLIENT_VERSION: value });

      expect(error).toBeDefined();
    });
  });

  describe('whitespace normalization', () => {
    it('trims surrounding whitespace off an otherwise-valid bound', () => {
      const { error, value } = schema.validate({ BGE_MIN_CLIENT_VERSION: '  1.2.3  ' });

      expect(error).toBeUndefined();
      expect(value.BGE_MIN_CLIENT_VERSION).toBe('1.2.3');
    });

    it('treats a whitespace-only value as no bound (empty), not a version', () => {
      const { error, value } = schema.validate({ BGE_MIN_CLIENT_VERSION: '   ' });

      expect(error).toBeUndefined();
      expect(value.BGE_MIN_CLIENT_VERSION).toBe('');
    });
  });
});
