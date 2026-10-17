import { missingVariables, withEnvironment, WORKSPACE_ROOT } from '@bge/testing';
import Joi from 'joi';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import systemConfig, { systemConfigValidationSchema } from './system.config';

const schema = Joi.object(systemConfigValidationSchema);

/** Validates as `ConfigModule.forRoot` does, passing the variables other schemas own. */
const validate = (variables: Record<string, string>) => schema.validate(variables, { allowUnknown: true });

describe("the api's system config", () => {
  // Jest assigns `test`, and it is the name `@bge/env` keys its defaults on.
  it('accepts NODE_ENV=test', () => {
    expect(validate({ NODE_ENV: 'test' }).error).toBeUndefined();
  });

  it('rejects NODE_ENV=testing, which no per-environment default is keyed on', () => {
    expect(validate({ NODE_ENV: 'testing' }).error?.message).toMatch(/NODE_ENV/);
  });

  // The suites start the api under these.
  it('accepts every NODE_ENV the CI workflow runs under', () => {
    const workflow = readFileSync(path.join(WORKSPACE_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const values = [...workflow.matchAll(/^\s*NODE_ENV:\s*['"]?([\w-]+)/gm)].map(([, value]) => value);

    expect(values.length).toBeGreaterThan(0);
    expect(values.filter((value) => validate({ NODE_ENV: value }).error)).toEqual([]);
  });

  it.each(['development', 'test'])('resolves under NODE_ENV=%s with nothing set', (environment) => {
    expect(missingVariables(systemConfig, { NODE_ENV: environment })).toEqual([]);
  });

  // A staging server is reachable from outside, so it takes no published key.
  it.each(['staging', 'production'])('requires DATA_ENCRYPTION_KEY under NODE_ENV=%s', (environment) => {
    expect(missingVariables(systemConfig, { NODE_ENV: environment })).toEqual(['DATA_ENCRYPTION_KEY']);
  });

  // The worker shares the key and refuses one this short, so the api must too.
  it('rejects a DATA_ENCRYPTION_KEY that is set but short', () => {
    expect(validate({ DATA_ENCRYPTION_KEY: 'short' }).error?.message).toMatch(/DATA_ENCRYPTION_KEY/);
  });

  // The variable hosting platforms set for a self-hosted server.
  it('listens on PORT', () => {
    expect(withEnvironment({ NODE_ENV: 'test', PORT: '8080' }, systemConfig).port).toBe(8080);
  });

  it('listens on 33333 when PORT is unset', () => {
    expect(withEnvironment({ NODE_ENV: 'test' }, systemConfig).port).toBe(33333);
  });

  it('rejects a PORT that is no port', () => {
    expect(validate({ PORT: '99999' }).error?.message).toMatch(/PORT/);
  });

  // `@bge/env` reads an empty variable as unset, so the config defaults it, or
  // refuses to start where it has no default.
  it.each(['PORT', 'DATA_ENCRYPTION_KEY'])('accepts an empty %s, for the config to read as unset', (variable) => {
    expect(validate({ [variable]: '' }).error).toBeUndefined();
  });

  it('requires DATA_ENCRYPTION_KEY under NODE_ENV=production when it is empty', () => {
    expect(missingVariables(systemConfig, { NODE_ENV: 'production', DATA_ENCRYPTION_KEY: '' })).toEqual([
      'DATA_ENCRYPTION_KEY',
    ]);
  });
});
