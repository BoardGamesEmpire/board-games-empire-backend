import type { SystemSetting } from '@bge/database';
import { createTestingModuleWithDb } from '@bge/testing';
import { ConfigService } from '@nestjs/config';
import { AUTH_BASE_PATH, AuthStrategyType } from './constants';
import { EmailAndPasswordStrategyDto } from './dto/email-and-password-strategy.dto';
import { OidcStrategyDto } from './dto/oidc-strategy.dto';
import { transformKeysToSnakeCase } from './interceptors/snakecase.interceptor';
import { StrategyService } from './strategy.service';

/**
 * The complete set of top-level keys the /.well-known/bge-identity document is
 * documented to expose, in snake_case wire form. This is the published shape —
 * adding a field to BgeDiscoveryDto without updating this list (or vice versa)
 * fails the wire-shape lock test below. Guards against accidentally leaking new
 * fields into the anonymous, pre-auth document.
 */
const DOCUMENTED_WIRE_KEYS = [
  'well_known_schema_version',
  'issuer',
  'bge_server_id',
  'name',
  'bge_min_client_version',
  'bge_max_client_version',
  'device_authorization_endpoint',
  'bge_auth_base_path',
  'bge_session_endpoint',
  'bge_sign_out_endpoint',
  'bge_passkey_supported',
  'bge_two_factor_supported',
  'bge_anonymous_auth_supported',
  'strategies',
].sort();

const BASE_ISSUER = 'https://api.example.com';
// BGE endpoints are emitted as root-relative paths, so the expected base for
// endpoint assertions is the path itself, independent of the issuer.
const AUTH_BASE = AUTH_BASE_PATH;

interface MockAuthConfig {
  url?: string;
  useEmailPasswordAuth?: boolean;
  disableEmailSignUp?: boolean;
  oidcWellKnownUrl?: string;
  oidcClientId?: string;
  oidcClientSecret?: string;
  oidcProviderId?: string;
  minClientVersion?: string;
  maxClientVersion?: string;
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
    bgeIdentity: {
      minClientVersion: config.minClientVersion ?? '',
      maxClientVersion: config.maxClientVersion ?? '',
    },
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

const MOCK_SYSTEM_SETTING = {
  identifier: 'test-server-id-00000000',
  name: 'Test Server',
};

const OIDC_CONFIG: Pick<MockAuthConfig, 'oidcWellKnownUrl' | 'oidcClientId' | 'oidcClientSecret'> = {
  oidcWellKnownUrl: 'https://auth.example.com/.well-known/openid-configuration',
  oidcClientId: 'test-client-id',
  oidcClientSecret: 'test-client-secret',
};

async function createService(
  config: MockAuthConfig,
  systemSetting: Partial<SystemSetting> = MOCK_SYSTEM_SETTING,
): Promise<StrategyService> {
  const { module, db } = await createTestingModuleWithDb({
    providers: [StrategyService, { provide: ConfigService, useValue: buildMockConfigService(config) }],
  });

  db.systemSetting.findFirst.mockResolvedValue(systemSetting as SystemSetting);
  db.systemSetting.findMany.mockResolvedValue([systemSetting] as SystemSetting[]);

  return module.get(StrategyService);
}

describe('StrategyService', () => {
  describe('getDiscovery()', () => {
    describe('RFC 8414-aligned fields', () => {
      it('sets issuer from auth.url config', async () => {
        const service = await createService({});
        const discovery = await service.getDiscovery();

        expect(discovery.issuer).toBe(BASE_ISSUER);
      });

      it('constructs deviceAuthorizationEndpoint as a relative path', async () => {
        const service = await createService({});
        const discovery = await service.getDiscovery();

        expect(discovery.deviceAuthorizationEndpoint).toBe(`${AUTH_BASE}/device`);
      });
    });

    describe('BGE infrastructure endpoints', () => {
      it('sets bgeAuthBasePath to AUTH_BASE_PATH (relative)', async () => {
        const service = await createService({});
        const discovery = await service.getDiscovery();

        expect(discovery.bgeAuthBasePath).toBe(AUTH_BASE);
      });

      it('sets bgeSessionEndpoint', async () => {
        const service = await createService({});
        const discovery = await service.getDiscovery();

        expect(discovery.bgeSessionEndpoint).toBe(`${AUTH_BASE}/get-session`);
      });

      it('sets bgeSignOutEndpoint', async () => {
        const service = await createService({});
        const discovery = await service.getDiscovery();

        expect(discovery.bgeSignOutEndpoint).toBe(`${AUTH_BASE}/sign-out`);
      });

      it('emits endpoints as relative paths, independent of the issuer', async () => {
        const customIssuer = 'https://bge.myserver.io';
        const service = await createService({ url: customIssuer });

        const discovery = await service.getDiscovery();

        // issuer is the one absolute field; the endpoints stay relative
        expect(discovery.issuer).toBe(customIssuer);
        expect(discovery.bgeAuthBasePath).toBe(AUTH_BASE_PATH);
        expect(discovery.bgeSessionEndpoint).toBe(`${AUTH_BASE_PATH}/get-session`);
        expect(discovery.bgeSignOutEndpoint).toBe(`${AUTH_BASE_PATH}/sign-out`);
        expect(discovery.deviceAuthorizationEndpoint).toBe(`${AUTH_BASE_PATH}/device`);
      });
    });

    describe('document compatibility + identity', () => {
      it('sets wellKnownSchemaVersion to 1', async () => {
        const service = await createService({});
        const discovery = await service.getDiscovery();

        expect(discovery.wellKnownSchemaVersion).toBe(1);
      });

      it('sets bgeServerId from the system setting identifier', async () => {
        const service = await createService({});
        const discovery = await service.getDiscovery();

        expect(discovery.bgeServerId).toBe(MOCK_SYSTEM_SETTING.identifier);
      });

      it('sets name from the system setting', async () => {
        const service = await createService({});
        const discovery = await service.getDiscovery();

        expect(discovery.name).toBe('Test Server');
      });
    });

    describe('client version compatibility bounds', () => {
      it('defaults both bounds to null when unconfigured', async () => {
        const service = await createService({});
        const discovery = await service.getDiscovery();

        expect(discovery.bgeMinClientVersion).toBeNull();
        expect(discovery.bgeMaxClientVersion).toBeNull();
      });

      it('advertises the configured minimum client version', async () => {
        const service = await createService({ minClientVersion: '0.1.0' });
        const discovery = await service.getDiscovery();

        expect(discovery.bgeMinClientVersion).toBe('0.1.0');
      });

      it('advertises the configured maximum client version', async () => {
        const service = await createService({ maxClientVersion: '2.0.0' });
        const discovery = await service.getDiscovery();

        expect(discovery.bgeMaxClientVersion).toBe('2.0.0');
      });

      it('treats an empty-string bound as no bound (null)', async () => {
        const service = await createService({ minClientVersion: '', maxClientVersion: '' });
        const discovery = await service.getDiscovery();

        expect(discovery.bgeMinClientVersion).toBeNull();
        expect(discovery.bgeMaxClientVersion).toBeNull();
      });
    });

    describe('wire shape (published-contract lock)', () => {
      it('exposes exactly the documented top-level keys — no extras — even fully populated', async () => {
        const service = await createService({
          useEmailPasswordAuth: true,
          minClientVersion: '0.1.0',
          maxClientVersion: '2.0.0',
          ...OIDC_CONFIG,
        });

        const wire = transformKeysToSnakeCase(await service.getDiscovery()) as Record<string, unknown>;

        expect(Object.keys(wire).sort()).toEqual(DOCUMENTED_WIRE_KEYS);
      });

      it('keeps null version bounds as present keys rather than dropping them', async () => {
        const service = await createService({});

        const wire = transformKeysToSnakeCase(await service.getDiscovery()) as Record<string, unknown>;

        expect(wire).toHaveProperty('bge_min_client_version', null);
        expect(wire).toHaveProperty('bge_max_client_version', null);
      });
    });

    describe('root-relative endpoint invariant', () => {
      it('AUTH_BASE_PATH is root-relative (leading slash)', () => {
        expect(AUTH_BASE_PATH.startsWith('/')).toBe(true);
      });

      it('emits every BGE endpoint as a root-relative path; issuer + external URLs stay absolute', async () => {
        const service = await createService({ useEmailPasswordAuth: true, ...OIDC_CONFIG });
        const discovery = await service.getDiscovery();

        // issuer is the one absolute BGE field
        expect(discovery.issuer).toMatch(/^https?:\/\//);

        // every BGE-hosted endpoint is root-relative, never absolute
        const relativePaths = [
          discovery.deviceAuthorizationEndpoint,
          discovery.bgeAuthBasePath,
          discovery.bgeSessionEndpoint,
          discovery.bgeSignOutEndpoint,
        ];

        for (const path of relativePaths) {
          expect(path.startsWith('/')).toBe(true);
          expect(path).not.toMatch(/^https?:\/\//);
        }

        const email = discovery.strategies[0] as EmailAndPasswordStrategyDto;
        const oidc = discovery.strategies[1] as OidcStrategyDto;
        expect(email.signInEndpoint.startsWith('/')).toBe(true);
        expect(email.signUpEndpoint?.startsWith('/')).toBe(true);
        expect(oidc.authorizationEndpoint.startsWith('/')).toBe(true);
        // the external IdP discovery URL is intentionally absolute
        expect(oidc.discoveryUrl).toMatch(/^https?:\/\//);
      });
    });

    describe('always-on capability flags', () => {
      it('reports bgePasskeySupported as true', async () => {
        const service = await createService({});
        const discovery = await service.getDiscovery();

        expect(discovery.bgePasskeySupported).toBe(true);
      });

      it('reports bgeTwoFactorSupported as true', async () => {
        const service = await createService({});
        const discovery = await service.getDiscovery();

        expect(discovery.bgeTwoFactorSupported).toBe(true);
      });

      it('reports bgeAnonymousAuthSupported as true', async () => {
        const service = await createService({});
        const discovery = await service.getDiscovery();

        expect(discovery.bgeAnonymousAuthSupported).toBe(true);
      });
    });

    describe('strategies array', () => {
      it('returns an empty strategies array when nothing is configured', async () => {
        const service = await createService({});
        const discovery = await service.getDiscovery();

        expect(discovery.strategies).toEqual([]);
      });

      describe('email and password strategy', () => {
        it('includes the strategy when useEmailPasswordAuth is true', async () => {
          const service = await createService({ useEmailPasswordAuth: true });
          const { strategies } = await service.getDiscovery();

          expect(strategies).toHaveLength(1);
          expect(strategies[0].type).toBe(AuthStrategyType.EmailAndPassword);
        });

        it('returns an EmailAndPasswordStrategyDto instance', async () => {
          const service = await createService({ useEmailPasswordAuth: true });
          const discovery = await service.getDiscovery();

          expect(discovery.strategies[0]).toBeInstanceOf(EmailAndPasswordStrategyDto);
        });

        it('sets signInEndpoint to the absolute BetterAuth email sign-in URL', async () => {
          const service = await createService({ useEmailPasswordAuth: true });
          const discovery = await service.getDiscovery();

          const [strategy] = discovery.strategies as EmailAndPasswordStrategyDto[];

          expect(strategy.signInEndpoint).toBe(`${AUTH_BASE}/sign-in/email`);
        });

        it('includes signUpEndpoint when registration is open', async () => {
          const service = await createService({ useEmailPasswordAuth: true, disableEmailSignUp: false });
          const discovery = await service.getDiscovery();

          const [strategy] = discovery.strategies as EmailAndPasswordStrategyDto[];

          expect(strategy.signUpEndpoint).toBe(`${AUTH_BASE}/sign-up/email`);
        });

        it('omits signUpEndpoint when registration is disabled', async () => {
          const service = await createService({ useEmailPasswordAuth: true, disableEmailSignUp: true });
          const discovery = await service.getDiscovery();

          const [strategy] = discovery.strategies as EmailAndPasswordStrategyDto[];

          expect(strategy.signUpEndpoint).toBeUndefined();
        });

        it('sets signUpDisabled: false when registration is open', async () => {
          const service = await createService({ useEmailPasswordAuth: true, disableEmailSignUp: false });
          const discovery = await service.getDiscovery();

          const [strategy] = discovery.strategies as EmailAndPasswordStrategyDto[];

          expect(strategy.signUpDisabled).toBe(false);
        });

        it('sets signUpDisabled: true when registration is closed', async () => {
          const service = await createService({ useEmailPasswordAuth: true, disableEmailSignUp: true });
          const discovery = await service.getDiscovery();

          const [strategy] = discovery.strategies as EmailAndPasswordStrategyDto[];

          expect(strategy.signUpDisabled).toBe(true);
        });
      });

      describe('OIDC strategy', () => {
        it('includes the strategy when all three OIDC vars are present', async () => {
          const service = await createService({ ...OIDC_CONFIG });
          const { strategies } = await service.getDiscovery();

          expect(strategies).toHaveLength(1);
          expect(strategies[0].type).toBe(AuthStrategyType.Oidc);
        });

        it('returns an OidcStrategyDto instance', async () => {
          const service = await createService({ ...OIDC_CONFIG });
          const discovery = await service.getDiscovery();

          expect(discovery.strategies[0]).toBeInstanceOf(OidcStrategyDto);
        });

        it('sets providerId from config', async () => {
          const service = await createService({ ...OIDC_CONFIG, oidcProviderId: 'acme-sso' });
          const discovery = await service.getDiscovery();

          const [strategy] = discovery.strategies as OidcStrategyDto[];

          expect(strategy.providerId).toBe('acme-sso');
        });

        it('falls back to "default-oidc-provider" when oidcProviderId is empty', async () => {
          const service = await createService({ ...OIDC_CONFIG, oidcProviderId: '' });
          const discovery = await service.getDiscovery();

          const [strategy] = discovery.strategies as OidcStrategyDto[];

          expect(strategy.providerId).toBe('default-oidc-provider');
        });

        it('sets discoveryUrl from config', async () => {
          const service = await createService({ ...OIDC_CONFIG });
          const discovery = await service.getDiscovery();

          const [strategy] = discovery.strategies as OidcStrategyDto[];

          expect(strategy.discoveryUrl).toBe(OIDC_CONFIG.oidcWellKnownUrl);
        });

        it('sets authorizationEndpoint to the absolute BetterAuth oauth2 sign-in URL', async () => {
          const service = await createService({ ...OIDC_CONFIG });
          const discovery = await service.getDiscovery();

          const [strategy] = discovery.strategies as OidcStrategyDto[];

          expect(strategy.authorizationEndpoint).toBe(`${AUTH_BASE}/sign-in/oauth2`);
        });

        it('does not expose clientId or clientSecret in the serialized response', async () => {
          const service = await createService({ ...OIDC_CONFIG });
          const discovery = await service.getDiscovery();
          const serialized = JSON.stringify(discovery);

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
          const discovery = await service.getDiscovery();

          expect(discovery.strategies).toHaveLength(0);
        });
      });

      describe('both strategies configured', () => {
        it('returns both strategies in order (email first, OIDC second)', async () => {
          const service = await createService({ useEmailPasswordAuth: true, ...OIDC_CONFIG });
          const { strategies } = await service.getDiscovery();

          expect(strategies).toHaveLength(2);
          expect(strategies[0].type).toBe(AuthStrategyType.EmailAndPassword);
          expect(strategies[1].type).toBe(AuthStrategyType.Oidc);
        });
      });
    });
  });
});
