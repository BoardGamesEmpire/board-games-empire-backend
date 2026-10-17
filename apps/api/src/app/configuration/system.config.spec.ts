import { missingVariables } from '@bge/testing';
import Joi from 'joi';
import systemConfig, { systemConfigValidationSchema } from './system.config';

const schema = Joi.object(systemConfigValidationSchema);

describe("the api's system config", () => {
  // Jest assigns `test`, and it is the name `@bge/env` keys its defaults on.
  it('accepts NODE_ENV=test', () => {
    expect(schema.validate({ NODE_ENV: 'test' }).error).toBeUndefined();
  });

  it('rejects NODE_ENV=testing, which no per-environment default is keyed on', () => {
    expect(schema.validate({ NODE_ENV: 'testing' }).error?.message).toMatch(/NODE_ENV/);
  });

  it.each(['development', 'test'])('resolves under NODE_ENV=%s with nothing set', (environment) => {
    expect(missingVariables(systemConfig, { NODE_ENV: environment })).toEqual([]);
  });

  // A staging server is reachable from outside, so it takes no published key.
  it.each(['staging', 'production'])('requires DATA_ENCRYPTION_KEY under NODE_ENV=%s', (environment) => {
    expect(missingVariables(systemConfig, { NODE_ENV: environment })).toEqual(['DATA_ENCRYPTION_KEY']);
  });
});
