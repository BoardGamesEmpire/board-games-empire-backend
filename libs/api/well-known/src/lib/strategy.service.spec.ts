import type { SystemSetting } from '@bge/database';
import { createTestingModuleWithDb } from '@bge/testing';
import { ConfigService } from '@nestjs/config';
import { AUTH_BASE_PATH, authPath, AuthStrategyType } from './constants';
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

/** A sign-in provider as the auth config holds it, secret included, as discovery receives it (#912). */
interface ProviderConfig {
  id: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  displayName: string;
}

interface MockAuthConfig {
  url?: string;
  useEmailPasswordAuth?: boolean;
  oidcProviders?: ProviderConfig[];
  minClientVersion?: string;
  maxClientVersion?: string;
}

function buildMockConfigService(config: MockAuthConfig): Pick<ConfigService, 'get' | 'getOrThrow'> {
  const configMap: Record<string, unknown> = {
    'auth.url': config.url ?? BASE_ISSUER,
    'auth.useEmailPasswordAuth': config.useEmailPasswordAuth ?? false,
    'auth.oidcProviders': config.oidcProviders ?? [],
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
  allowUserRegistration: true,
};

const REGISTRATION_CLOSED = { ...MOCK_SYSTEM_SETTING, allowUserRegistration: false };

const GOOGLE: ProviderConfig = {
  id: 'google',
  discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
  clientId: 'google-client-id',
  clientSecret: 'google-client-secret',
  displayName: 'Google',
};

const AUTHENTIK: ProviderConfig = {
  id: 'authentik',
  discoveryUrl: 'https://auth.example.com/application/o/bge/.well-known/openid-configuration',
  clientId: 'authentik-client-id',
  clientSecret: 'authentik-client-secret',
  displayName: 'Authentik',
};

const OIDC_CONFIG: Pick<MockAuthConfig, 'oidcProviders'> = { oidcProviders: [AUTHENTIK] };

async function createService(
  config: MockAuthConfig,
  systemSetting: Partial<SystemSetting> = MOCK_SYSTEM_SETTING,
): Promise<StrategyService> {
  const { module, db } = await createTestingModuleWithDb({
    providers: [StrategyService, { provide: ConfigService, useValue: buildMockConfigService(config) }],
  });

  // Only the singleton row resolves: it is the row the auth gates enforce, so
  // discovery must advertise that one and no other.
  db.systemSetting.findUnique.mockImplementation(((args: { where?: { singleton?: boolean } }) =>
    Promise.resolve(args.where?.singleton === true ? systemSetting : null)) as never);

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

      it('authPath normalizes a missing leading slash so output is always root-relative', () => {
        expect(authPath('/device')).toBe(`${AUTH_BASE_PATH}/device`);
        expect(authPath('device')).toBe(`${AUTH_BASE_PATH}/device`);
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
    });

    describe('anonymous sign-in flag', () => {
      it('reports anonymous sign-in as supported while registration is open', async () => {
        const service = await createService({});
        const discovery = await service.getDiscovery();

        expect(discovery.bgeAnonymousAuthSupported).toBe(true);
      });

      // An anonymous sign-in creates an account, so closing registration
      // refuses it too (#585).
      it('reports anonymous sign-in as unsupported while registration is closed', async () => {
        const service = await createService({}, REGISTRATION_CLOSED);
        const discovery = await service.getDiscovery();

        expect(discovery.bgeAnonymousAuthSupported).toBe(false);
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
          const service = await createService({ useEmailPasswordAuth: true });
          const discovery = await service.getDiscovery();

          const [strategy] = discovery.strategies as EmailAndPasswordStrategyDto[];

          expect(strategy.signUpEndpoint).toBe(`${AUTH_BASE}/sign-up/email`);
        });

        it('omits signUpEndpoint when registration is closed', async () => {
          const service = await createService({ useEmailPasswordAuth: true }, REGISTRATION_CLOSED);
          const discovery = await service.getDiscovery();

          const [strategy] = discovery.strategies as EmailAndPasswordStrategyDto[];

          expect(strategy.signUpEndpoint).toBeUndefined();
        });

        it('sets signUpDisabled: false when registration is open', async () => {
          const service = await createService({ useEmailPasswordAuth: true });
          const discovery = await service.getDiscovery();

          const [strategy] = discovery.strategies as EmailAndPasswordStrategyDto[];

          expect(strategy.signUpDisabled).toBe(false);
        });

        it('sets signUpDisabled: true when registration is closed', async () => {
          const service = await createService({ useEmailPasswordAuth: true }, REGISTRATION_CLOSED);
          const discovery = await service.getDiscovery();

          const [strategy] = discovery.strategies as EmailAndPasswordStrategyDto[];

          expect(strategy.signUpDisabled).toBe(true);
        });
      });

      describe('OIDC strategies, one per sign-in provider', () => {
        it('lists one oidc strategy per sign-in provider, in list order, after email and password (#912)', async () => {
          const service = await createService({ useEmailPasswordAuth: true, oidcProviders: [GOOGLE, AUTHENTIK] });
          const { strategies } = await service.getDiscovery();

          expect(strategies.map((s) => s.type)).toEqual([
            AuthStrategyType.EmailAndPassword,
            AuthStrategyType.Oidc,
            AuthStrategyType.Oidc,
          ]);
          expect(strategies[1]).toBeInstanceOf(OidcStrategyDto);
          expect(strategies[2]).toEqual({
            type: 'oidc',
            providerId: 'authentik',
            displayName: 'Authentik',
            discoveryUrl: AUTHENTIK.discoveryUrl,
            authorizationEndpoint: `${AUTH_BASE}/sign-in/oauth2`,
            signUpDisabled: false,
          });
        });

        it('never lists a client id or secret (#912)', async () => {
          const service = await createService({ oidcProviders: [GOOGLE, AUTHENTIK] });
          const serialized = JSON.stringify(await service.getDiscovery());

          for (const provider of [GOOGLE, AUTHENTIK]) {
            expect(serialized).not.toContain(provider.clientId);
            expect(serialized).not.toContain(provider.clientSecret);
          }
        });

        it('lists no oidc strategy when no sign-in provider is configured (#912)', async () => {
          const service = await createService({ useEmailPasswordAuth: true, oidcProviders: [] });
          const { strategies } = await service.getDiscovery();

          expect(strategies.map((s) => s.type)).toEqual([AuthStrategyType.EmailAndPassword]);
        });

        it('marks every sign-in provider sign-up disabled while registration is closed (#585, #912)', async () => {
          const service = await createService({ oidcProviders: [GOOGLE, AUTHENTIK] }, REGISTRATION_CLOSED);
          const { strategies } = await service.getDiscovery();

          expect(strategies).toHaveLength(2);
          expect((strategies as OidcStrategyDto[]).map((s) => s.signUpDisabled)).toEqual([true, true]);
        });
      });
    });
  });
});
