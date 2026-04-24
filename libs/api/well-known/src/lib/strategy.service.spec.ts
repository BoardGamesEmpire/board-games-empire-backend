import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AUTH_BASE_PATH, AuthStrategyType } from './constants';
import { EmailAndPasswordStrategyDto } from './dto/email-and-password-strategy.dto';
import { OidcStrategyDto } from './dto/oidc-strategy.dto';
import { StrategyService } from './strategy.service';

const BASE_ISSUER = 'https://api.example.com';
const AUTH_BASE = `${BASE_ISSUER}${AUTH_BASE_PATH}`;

interface MockAuthConfig {
  url?: string;
  useEmailPasswordAuth?: boolean;
  disableEmailSignUp?: boolean;
  oidcWellKnownUrl?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcProviderId?: string;
}

function buildMockConfigService(config: MockAuthConfig): Pick<ConfigService, 'get' | 'getOrThrow'> {
  const configMap: Record<string, unknown> = {
    'auth.url': config.url ?? BASE_ISSUER,
    'auth.useEmailPasswordAuth': config.useEmailPasswordAuth ?? false,
    'auth.disableEmailSignUp': config.disableEmailSignUp ?? false,
    'auth.oidcWellKnownUrl': config.oidcWellKnownUrl ?? '',
    'auth.oidcClientId': config.oidcClientId ?? '',
    'auth.oidcClientSecret': config.oidcClientSecret ?? '',
    'auth.oidcProviderId': config.oidcProviderId ?? '',
  };

  return {
    get: jest.fn().mockImplementation(<T>(key: string) => configMap[key] as T),
    getOrThrow: jest.fn().mockImplementation(<T>(key: string) => {
      const value = configMap[key];

      if (value === undefined) {
        throw new Error(`Config key "${key}" not found in test`);
      }

      return value as T;
    }),
  };
}

const OIDC_CONFIG: Pick<MockAuthConfig, 'oidcWellKnownUrl' | 'oidcClientId' | 'oidcClientSecret'> = {
  oidcWellKnownUrl: 'https://auth.example.com/.well-known/openid-configuration',
  oidcClientId: 'test-client-id',
  oidcClientSecret: 'test-client-secret',
};

async function createService(config: MockAuthConfig): Promise<StrategyService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [StrategyService, { provide: ConfigService, useValue: buildMockConfigService(config) }],
  }).compile();

  return module.get(StrategyService);
}

describe('StrategyService', () => {
  describe('getDiscovery()', () => {
    describe('RFC 8414-aligned fields', () => {
      it('sets issuer from auth.url config', async () => {
        const service = await createService({});
        expect(service.getDiscovery().issuer).toBe(BASE_ISSUER);
      });

      it('constructs deviceAuthorizationEndpoint from issuer + AUTH_BASE_PATH', async () => {
        const service = await createService({});
        expect(service.getDiscovery().deviceAuthorizationEndpoint).toBe(`${AUTH_BASE}/device`);
      });
    });

    describe('BGE infrastructure endpoints', () => {
      it('sets bgeAuthBaseUrl to issuer + AUTH_BASE_PATH', async () => {
        const service = await createService({});
        expect(service.getDiscovery().bgeAuthBaseUrl).toBe(AUTH_BASE);
      });

      it('sets bgeSessionEndpoint', async () => {
        const service = await createService({});
        expect(service.getDiscovery().bgeSessionEndpoint).toBe(`${AUTH_BASE}/get-session`);
      });

      it('sets bgeSignOutEndpoint', async () => {
        const service = await createService({});
        expect(service.getDiscovery().bgeSignOutEndpoint).toBe(`${AUTH_BASE}/sign-out`);
      });

      it('reflects a non-default issuer in all constructed URLs', async () => {
        const customIssuer = 'https://bge.myserver.io';
        const service = await createService({ url: customIssuer });

        const discovery = service.getDiscovery();
        const expectedBase = `${customIssuer}${AUTH_BASE_PATH}`;

        expect(discovery.issuer).toBe(customIssuer);
        expect(discovery.bgeAuthBaseUrl).toBe(expectedBase);
        expect(discovery.bgeSessionEndpoint).toBe(`${expectedBase}/get-session`);
        expect(discovery.bgeSignOutEndpoint).toBe(`${expectedBase}/sign-out`);
        expect(discovery.deviceAuthorizationEndpoint).toBe(`${expectedBase}/device`);
      });
    });

    describe('always-on capability flags', () => {
      it('reports bgePasskeySupported as true', async () => {
        const service = await createService({});
        expect(service.getDiscovery().bgePasskeySupported).toBe(true);
      });

      it('reports bgeTwoFactorSupported as true', async () => {
        const service = await createService({});
        expect(service.getDiscovery().bgeTwoFactorSupported).toBe(true);
      });

      it('reports bgeAnonymousAuthSupported as true', async () => {
        const service = await createService({});
        expect(service.getDiscovery().bgeAnonymousAuthSupported).toBe(true);
      });
    });

    describe('strategies array', () => {
      it('returns an empty strategies array when nothing is configured', async () => {
        const service = await createService({});
        expect(service.getDiscovery().strategies).toEqual([]);
      });

      describe('email and password strategy', () => {
        it('includes the strategy when useEmailPasswordAuth is true', async () => {
          const service = await createService({ useEmailPasswordAuth: true });
          const { strategies } = service.getDiscovery();

          expect(strategies).toHaveLength(1);
          expect(strategies[0].type).toBe(AuthStrategyType.EmailAndPassword);
        });

        it('returns an EmailAndPasswordStrategyDto instance', async () => {
          const service = await createService({ useEmailPasswordAuth: true });
          expect(service.getDiscovery().strategies[0]).toBeInstanceOf(EmailAndPasswordStrategyDto);
        });

        it('sets signInEndpoint to the absolute BetterAuth email sign-in URL', async () => {
          const service = await createService({ useEmailPasswordAuth: true });
          const [strategy] = service.getDiscovery().strategies as EmailAndPasswordStrategyDto[];

          expect(strategy.signInEndpoint).toBe(`${AUTH_BASE}/sign-in/email`);
        });

        it('includes signUpEndpoint when registration is open', async () => {
          const service = await createService({ useEmailPasswordAuth: true, disableEmailSignUp: false });
          const [strategy] = service.getDiscovery().strategies as EmailAndPasswordStrategyDto[];

          expect(strategy.signUpEndpoint).toBe(`${AUTH_BASE}/sign-up/email`);
        });

        it('omits signUpEndpoint when registration is disabled', async () => {
          const service = await createService({ useEmailPasswordAuth: true, disableEmailSignUp: true });
          const [strategy] = service.getDiscovery().strategies as EmailAndPasswordStrategyDto[];

          expect(strategy.signUpEndpoint).toBeUndefined();
        });

        it('sets signUpDisabled: false when registration is open', async () => {
          const service = await createService({ useEmailPasswordAuth: true, disableEmailSignUp: false });
          const [strategy] = service.getDiscovery().strategies as EmailAndPasswordStrategyDto[];

          expect(strategy.signUpDisabled).toBe(false);
        });

        it('sets signUpDisabled: true when registration is closed', async () => {
          const service = await createService({ useEmailPasswordAuth: true, disableEmailSignUp: true });
          const [strategy] = service.getDiscovery().strategies as EmailAndPasswordStrategyDto[];

          expect(strategy.signUpDisabled).toBe(true);
        });
      });

      describe('OIDC strategy', () => {
        it('includes the strategy when all three OIDC vars are present', async () => {
          const service = await createService({ ...OIDC_CONFIG });
          const { strategies } = service.getDiscovery();

          expect(strategies).toHaveLength(1);
          expect(strategies[0].type).toBe(AuthStrategyType.Oidc);
        });

        it('returns an OidcStrategyDto instance', async () => {
          const service = await createService({ ...OIDC_CONFIG });
          expect(service.getDiscovery().strategies[0]).toBeInstanceOf(OidcStrategyDto);
        });

        it('sets providerId from config', async () => {
          const service = await createService({ ...OIDC_CONFIG, oidcProviderId: 'acme-sso' });
          const [strategy] = service.getDiscovery().strategies as OidcStrategyDto[];

          expect(strategy.providerId).toBe('acme-sso');
        });

        it('falls back to "default-oidc-provider" when oidcProviderId is empty', async () => {
          const service = await createService({ ...OIDC_CONFIG, oidcProviderId: '' });
          const [strategy] = service.getDiscovery().strategies as OidcStrategyDto[];

          expect(strategy.providerId).toBe('default-oidc-provider');
        });

        it('sets discoveryUrl from config', async () => {
          const service = await createService({ ...OIDC_CONFIG });
          const [strategy] = service.getDiscovery().strategies as OidcStrategyDto[];

          expect(strategy.discoveryUrl).toBe(OIDC_CONFIG.oidcWellKnownUrl);
        });

        it('sets authorizationEndpoint to the absolute BetterAuth oauth2 sign-in URL', async () => {
          const service = await createService({ ...OIDC_CONFIG });
          const [strategy] = service.getDiscovery().strategies as OidcStrategyDto[];

          expect(strategy.authorizationEndpoint).toBe(`${AUTH_BASE}/sign-in/oauth2`);
        });

        it('does not expose clientId or clientSecret in the serialized response', async () => {
          const service = await createService({ ...OIDC_CONFIG });
          const serialized = JSON.stringify(service.getDiscovery());

          expect(serialized).not.toContain('test-client-id');
          expect(serialized).not.toContain('test-client-secret');
        });

        it.each([
          [
            'oidcWellKnownUrl missing',
            {
              oidcClientId: OIDC_CONFIG.oidcClientId,
              oidcClientSecret: OIDC_CONFIG.oidcClientSecret,
              oidcWellKnownUrl: '',
            },
          ],
          [
            'oidcClientId missing',
            {
              oidcWellKnownUrl: OIDC_CONFIG.oidcWellKnownUrl,
              oidcClientSecret: OIDC_CONFIG.oidcClientSecret,
              oidcClientId: '',
            },
          ],
          [
            'oidcClientSecret missing',
            {
              oidcWellKnownUrl: OIDC_CONFIG.oidcWellKnownUrl,
              oidcClientId: OIDC_CONFIG.oidcClientId,
              oidcClientSecret: '',
            },
          ],
        ])('omits OIDC strategy when %s', async (_label, partialConfig) => {
          const service = await createService(partialConfig);
          expect(service.getDiscovery().strategies).toHaveLength(0);
        });
      });

      describe('both strategies configured', () => {
        it('returns both strategies in order (email first, OIDC second)', async () => {
          const service = await createService({ useEmailPasswordAuth: true, ...OIDC_CONFIG });
          const { strategies } = service.getDiscovery();

          expect(strategies).toHaveLength(2);
          expect(strategies[0].type).toBe(AuthStrategyType.EmailAndPassword);
          expect(strategies[1].type).toBe(AuthStrategyType.Oidc);
        });
      });
    });
  });
});
