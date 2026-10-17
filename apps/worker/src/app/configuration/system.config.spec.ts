import { missingVariables } from '@bge/testing';
import Joi from 'joi';
import systemConfig, { systemConfigValidationSchema } from './system.config';

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
    const { error } = schema.validate({ DATA_ENCRYPTION_KEY: 'test-secret' });

    expect(error).toBeUndefined();
  });

  it('rejects a key that is set but short', () => {
    const { error } = schema.validate({ DATA_ENCRYPTION_KEY: 'short' });

    expect(error?.message).toMatch(/DATA_ENCRYPTION_KEY/);
  });
});

describe("the worker's system config", () => {
  it.each(['development', 'test'])('resolves under NODE_ENV=%s with nothing set', (environment) => {
    expect(missingVariables(systemConfig, { NODE_ENV: environment })).toEqual([]);
  });

  // The api shares the key, and requires it in the same environments.
  it.each(['staging', 'production'])('requires DATA_ENCRYPTION_KEY under NODE_ENV=%s', (environment) => {
    expect(missingVariables(systemConfig, { NODE_ENV: environment })).toEqual(['DATA_ENCRYPTION_KEY']);
  });
});
