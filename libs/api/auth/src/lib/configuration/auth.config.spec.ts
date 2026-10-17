import { missingVariables } from '@bge/testing';
import authConfig from './auth.config';

describe('the auth config', () => {
  it.each(['development', 'test'])('resolves under NODE_ENV=%s with nothing set', (environment) => {
    expect(missingVariables(authConfig, { NODE_ENV: environment })).toEqual([]);
  });

  // A staging server is reachable from outside, so it signs sessions with no
  // published secret. And sign-in fails at an address clients don't reach.
  it.each(['staging', 'production'])(
    'requires BETTER_AUTH_SECRET and BETTER_AUTH_URL under NODE_ENV=%s',
    (environment) => {
      expect(missingVariables(authConfig, { NODE_ENV: environment })).toEqual([
        'BETTER_AUTH_SECRET',
        'BETTER_AUTH_URL',
      ]);
    },
  );
});
