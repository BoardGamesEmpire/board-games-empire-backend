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

  // Proves the config calls the provider reader: a listed provider with no
  // variables stops the boot and names its four (#912).
  it('requires the variables of every listed sign-in provider (#912)', () => {
    expect(
      missingVariables(authConfig, {
        NODE_ENV: 'staging',
        BETTER_AUTH_SECRET: 'a-long-enough-secret',
        BETTER_AUTH_URL: 'http://localhost',
        OIDC_PROVIDERS: 'a',
      }),
    ).toEqual(['OIDC_A_DISCOVERY_URL', 'OIDC_A_CLIENT_ID', 'OIDC_A_CLIENT_SECRET', 'OIDC_A_DISPLAY_NAME']);
  });
});
