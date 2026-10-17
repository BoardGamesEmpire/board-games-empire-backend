import { missingVariables } from '@bge/testing';
import authConfig from './auth.config';

describe('the auth config', () => {
  it.each(['development', 'test'])('resolves under NODE_ENV=%s with nothing set', (environment) => {
    expect(missingVariables(authConfig, { NODE_ENV: environment })).toEqual([]);
  });

  // A staging server is reachable from outside, so it signs sessions with no published secret.
  it.each(['staging', 'production'])('requires BETTER_AUTH_SECRET under NODE_ENV=%s', (environment) => {
    expect(missingVariables(authConfig, { NODE_ENV: environment })).toContain('BETTER_AUTH_SECRET');
  });
});
