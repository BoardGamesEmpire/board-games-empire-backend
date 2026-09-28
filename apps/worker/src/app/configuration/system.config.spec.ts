import Joi from 'joi';
import { systemConfigValidationSchema } from './system.config';

const schema = Joi.object<{ DATA_ENCRYPTION_KEY?: string }>(systemConfigValidationSchema);

describe('systemConfigValidationSchema', () => {
  // Validation runs before `defaultsFor` can supply the key, so a schema that
  // rejects its absence makes that default unreachable: the worker then cannot
  // boot without a `.env`, in CI or a fresh checkout.
  it('accepts a config with no encryption key, leaving it to the environment defaults', () => {
    const { error } = schema.validate({});

    expect(error).toBeUndefined();
  });

  it('accepts a key of at least ten characters', () => {
    const { error } = schema.validate({ DATA_ENCRYPTION_KEY: 'testing-secret' });

    expect(error).toBeUndefined();
  });

  it('rejects a key that is set but short', () => {
    const { error } = schema.validate({ DATA_ENCRYPTION_KEY: 'short' });

    expect(error?.message).toMatch(/DATA_ENCRYPTION_KEY/);
  });
});
