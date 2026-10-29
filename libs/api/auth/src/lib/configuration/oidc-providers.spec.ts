import { missingVariables, withEnvironment } from '@bge/testing';
import {
  OidcProvidersConfigError,
  oidcVariableSegment,
  readOidcProviders,
  unlistedOidcVariables,
} from './oidc-providers';

/** The four variables one provider needs, `segment` being its id upper-cased. */
function full(id: string, segment: string): Record<string, string> {
  return {
    [`OIDC_${segment}_DISCOVERY_URL`]: `https://${id}.example/.well-known/openid-configuration`,
    [`OIDC_${segment}_CLIENT_ID`]: `${id}-id`,
    [`OIDC_${segment}_CLIENT_SECRET`]: `${id}-secret`,
    [`OIDC_${segment}_DISPLAY_NAME`]: id.charAt(0).toUpperCase() + id.slice(1),
  };
}

function configError(variables: Record<string, string>): OidcProvidersConfigError {
  try {
    withEnvironment({ NODE_ENV: 'test', ...variables }, readOidcProviders);
  } catch (error) {
    if (error instanceof OidcProvidersConfigError) {
      return error;
    }

    throw error;
  }

  throw new Error('expected readOidcProviders to throw');
}

describe('readOidcProviders', () => {
  it('reads several sign-in providers in list order (#912)', () => {
    const providers = withEnvironment(
      {
        NODE_ENV: 'test',
        OIDC_PROVIDERS: 'google, authentik',
        ...full('google', 'GOOGLE'),
        ...full('authentik', 'AUTHENTIK'),
      },
      readOidcProviders,
    );

    expect(providers.map((provider) => provider.id)).toEqual(['google', 'authentik']);
    expect(providers[1]).toEqual({
      id: 'authentik',
      discoveryUrl: 'https://authentik.example/.well-known/openid-configuration',
      clientId: 'authentik-id',
      clientSecret: 'authentik-secret',
      displayName: 'Authentik',
      allowUnverifiedEmail: false,
    });
  });

  it.each([
    ['true', true],
    ['TRUE', true],
    ['false', false],
  ])('reads ALLOW_UNVERIFIED_EMAIL=%p as %p (#912)', (value, expected) => {
    const [provider] = withEnvironment(
      { NODE_ENV: 'test', OIDC_PROVIDERS: 'a', ...full('a', 'A'), OIDC_A_ALLOW_UNVERIFIED_EMAIL: value },
      readOidcProviders,
    );

    expect(provider.allowUnverifiedEmail).toBe(expected);
  });

  // A typo must not quietly leave the provider strict, refusing sign-ins the
  // operator meant to allow, with nothing at boot to say why.
  it('refuses an ALLOW_UNVERIFIED_EMAIL that is neither true nor false, and names it (#912)', () => {
    const error = configError({ OIDC_PROVIDERS: 'a', ...full('a', 'A'), OIDC_A_ALLOW_UNVERIFIED_EMAIL: 'yes please' });

    expect(error.malformedKeys).toEqual(['OIDC_A_ALLOW_UNVERIFIED_EMAIL']);
    expect(error.message).toContain('OIDC_A_ALLOW_UNVERIFIED_EMAIL is neither true nor false');
  });

  it('turns a hyphen in the id into an underscore in its variables (#912)', () => {
    const providers = withEnvironment(
      { NODE_ENV: 'test', OIDC_PROVIDERS: 'google-work', ...full('google-work', 'GOOGLE_WORK') },
      readOidcProviders,
    );

    expect(providers.map((provider) => provider.id)).toEqual(['google-work']);
    expect(oidcVariableSegment('google-work')).toBe('GOOGLE_WORK');
  });

  it.each([
    ['unset', {}],
    ['empty', { OIDC_PROVIDERS: '' }],
  ])('reads no providers when the list is %s (#912)', (_state, vars) => {
    expect(withEnvironment({ NODE_ENV: 'test', ...vars }, readOidcProviders)).toEqual([]);
  });

  // A secret mounted from a file often ends in a newline, which the provider
  // would refuse as part of the secret.
  it('trims the values it returns (#912)', () => {
    const [provider] = withEnvironment(
      {
        NODE_ENV: 'test',
        OIDC_PROVIDERS: 'a',
        ...full('a', 'A'),
        OIDC_A_DISCOVERY_URL: ' https://a.example/.well-known/openid-configuration ',
        OIDC_A_CLIENT_SECRET: 'a-secret\n',
      },
      readOidcProviders,
    );

    expect(provider).toMatchObject({
      discoveryUrl: 'https://a.example/.well-known/openid-configuration',
      clientSecret: 'a-secret',
    });
  });

  it('names every missing variable at once (#912)', () => {
    expect(
      missingVariables(readOidcProviders, { NODE_ENV: 'test', OIDC_PROVIDERS: 'a,b', OIDC_A_CLIENT_ID: 'x' }),
    ).toEqual([
      'OIDC_A_DISCOVERY_URL',
      'OIDC_A_CLIENT_SECRET',
      'OIDC_A_DISPLAY_NAME',
      'OIDC_B_DISCOVERY_URL',
      'OIDC_B_CLIENT_ID',
      'OIDC_B_CLIENT_SECRET',
      'OIDC_B_DISPLAY_NAME',
    ]);
  });

  it('reads an empty variable as missing (#912)', () => {
    expect(
      missingVariables(readOidcProviders, {
        NODE_ENV: 'test',
        OIDC_PROVIDERS: 'a',
        ...full('a', 'A'),
        OIDC_A_CLIENT_ID: '',
      }),
    ).toEqual(['OIDC_A_CLIENT_ID']);
  });

  it.each(['Google', 'my_sso', 'a/b', 'a b'])(
    'refuses the id %p: only lowercase letters, digits and hyphens (#912)',
    (id) => {
      const error = configError({ OIDC_PROVIDERS: id });

      expect(error.invalidIds).toEqual([id]);
      expect(error.message).toContain(id);
    },
  );

  // splitTrimFilter would drop the empty entry a trailing comma leaves, and a
  // typo would pass unnoticed.
  it('refuses an empty entry, as a trailing comma leaves (#912)', () => {
    expect(configError({ OIDC_PROVIDERS: 'authentik,', ...full('authentik', 'AUTHENTIK') }).invalidIds).toEqual(['']);
  });

  it('refuses a duplicate id (#912)', () => {
    const error = configError({ OIDC_PROVIDERS: 'a,a', ...full('a', 'A') });

    expect(error.duplicateIds).toEqual(['a']);
    expect(error.invalidIds).toEqual([]);
  });

  it('names bad ids and missing variables in one error (#912)', () => {
    const error = configError({ OIDC_PROVIDERS: 'Bad,b' });

    expect(error.invalidIds).toEqual(['Bad']);
    expect(error.missingKeys).toEqual([
      'OIDC_B_DISCOVERY_URL',
      'OIDC_B_CLIENT_ID',
      'OIDC_B_CLIENT_SECRET',
      'OIDC_B_DISPLAY_NAME',
    ]);
    expect(error.message).toContain('Bad');
    expect(error.message).toContain('OIDC_B_CLIENT_SECRET');
  });

  it("refuses a listed provider's malformed discovery URL and names it (#912)", () => {
    const error = configError({ OIDC_PROVIDERS: 'a', ...full('a', 'A'), OIDC_A_DISCOVERY_URL: 'not a url' });

    expect(error.malformedKeys).toEqual(['OIDC_A_DISCOVERY_URL']);
    expect(error.invalidIds).toEqual([]);
    expect(error.missingKeys).toEqual([]);
    expect(error.message).toContain('OIDC_A_DISCOVERY_URL');
  });

  it.each(['file:///etc/passwd', 'javascript:alert(1)', 'ftp://a.example/'])(
    'refuses a discovery URL with the scheme of %p, since the api fetches it and clients are handed it (#912)',
    (url) => {
      const error = configError({ OIDC_PROVIDERS: 'a', ...full('a', 'A'), OIDC_A_DISCOVERY_URL: url });

      expect(error.malformedKeys).toEqual(['OIDC_A_DISCOVERY_URL']);
    },
  );

  it('accepts an http discovery URL, as a provider on the local network serves (#912)', () => {
    const url = 'http://auth.lan/.well-known/openid-configuration';
    const providers = withEnvironment(
      { NODE_ENV: 'test', OIDC_PROVIDERS: 'a', ...full('a', 'A'), OIDC_A_DISCOVERY_URL: url },
      readOidcProviders,
    );

    expect(providers[0].discoveryUrl).toBe(url);
  });

  // A missing discovery URL is reported as missing, not as malformed too.
  it('names a malformed discovery URL in the same error as a bad id and a missing variable (#912)', () => {
    const error = configError({
      OIDC_PROVIDERS: 'Bad,a,b',
      ...full('a', 'A'),
      OIDC_A_DISCOVERY_URL: 'not a url',
      ...full('b', 'B'),
      OIDC_B_DISCOVERY_URL: '',
    });

    expect(error.invalidIds).toEqual(['Bad']);
    expect(error.malformedKeys).toEqual(['OIDC_A_DISCOVERY_URL']);
    expect(error.missingKeys).toEqual(['OIDC_B_DISCOVERY_URL']);
    expect(error.message).toContain('Bad');
    expect(error.message).toContain('OIDC_A_DISCOVERY_URL');
    expect(error.message).toContain('OIDC_B_DISCOVERY_URL');
  });
});

describe('unlistedOidcVariables', () => {
  it('lists provider variables whose provider is not listed, and nothing else (#912)', () => {
    expect(
      unlistedOidcVariables(
        {
          OIDC_PROVIDERS: 'google',
          OIDC_GOOGLE_CLIENT_ID: 'x',
          OIDC_GOGLE_CLIENT_ID: 'y',
          OIDC_GOOGLE_WORK_DISPLAY_NAME: 'z',
          OIDC_GOOGLE_WORK_ALLOW_UNVERIFIED_EMAIL: 'true',
          OIDC_GOOGLE_ALLOW_UNVERIFIED_EMAIL: 'true',
          OIDC_CLIENT_ID: 'old',
        },
        ['google'],
      ),
    ).toEqual(['OIDC_GOGLE_CLIENT_ID', 'OIDC_GOOGLE_WORK_ALLOW_UNVERIFIED_EMAIL', 'OIDC_GOOGLE_WORK_DISPLAY_NAME']);
  });
});
