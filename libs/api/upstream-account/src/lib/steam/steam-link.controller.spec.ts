import type { Actor } from '@bge/actor-context';
import { AuditContextService } from '@bge/actor-context';
import { AuthService } from '@bge/auth';
import { Action, ResourceType, Upstream } from '@bge/database';
import { I18nExceptionFilter, LocaleResolutionService } from '@bge/i18n';
import type { AppAbility } from '@bge/permissions';
import { CHECK_POLICIES_KEY, PoliciesGuard } from '@bge/permissions';
import type { INestApplication } from '@nestjs/common';
import { HttpStatus } from '@nestjs/common';
import {
  GUARDS_METADATA,
  HEADERS_METADATA,
  PATH_METADATA,
  REDIRECT_METADATA,
  ROUTE_ARGS_METADATA,
} from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { ConfigService } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { AllowAnonymous, OptionalAuth } from '@thallesp/nestjs-better-auth';
import { I18nService, I18nValidationPipe } from 'nestjs-i18n';
import type { UpstreamPrivacyPolicyDto } from '../dto/upstream-accounts-response.dto';
import { UpstreamAccountService } from '../upstream-account.service';
import { SteamLinkController } from './steam-link.controller';
import { STEAM_RETURN_PATH, SteamLinkService } from './steam-link.service';
import type { SteamVerification } from './steam-openid';
import { SteamOpenIdVerifier } from './steam-openid';
import { OPENID_2_NAMESPACE } from './steam-openid.constants';
import type { PendingSteamSignIn } from './steam-sign-in.store';
import { SteamSignInStore } from './steam-sign-in.store';

/**
 * The keys better-auth's decorators write, read off the decorators rather than
 * restated: the package does not export them, and these are the keys the
 * global auth guard admits a request with no actor by.
 */
const ALLOW_ANONYMOUS_KEY = AllowAnonymous().KEY;
const OPTIONAL_AUTH_KEY = OptionalAuth().KEY;

const ME = 'user-1';
const STEAM_ID = '76561197960287930';
const RETURN_TO = 'https://app.example/settings/upstream-accounts?tab=links';

const policy: UpstreamPrivacyPolicyDto = {
  url: '/api/privacy-policy',
  language: 'en',
  updatedAt: '2026-11-18T00:00:00.000Z',
};

const user: Actor = { kind: 'user', userId: ME };

describe('SteamLinkController (#935)', () => {
  describe('routes', () => {
    const { startSignIn, finishSignIn } = SteamLinkController.prototype;

    it('serves the return at the address the sign-in sends Steam', () => {
      const base = Reflect.getMetadata(PATH_METADATA, SteamLinkController);
      const route = Reflect.getMetadata(PATH_METADATA, finishSignIn);

      expect(`/api/${base}/${route}`).toBe(STEAM_RETURN_PATH);
    });

    // The browser comes back from Steam on its own; the return decides what a
    // missing or wrong session means, so the global auth guard must let it in.
    // Starting needs a signed-in user.
    it('marks only the return @OptionalAuth()', () => {
      expect(Reflect.getMetadata(OPTIONAL_AUTH_KEY, finishSignIn)).toBe(true);
      expect(Reflect.getMetadata(OPTIONAL_AUTH_KEY, startSignIn)).toBeUndefined();
      expect(Reflect.getMetadata(OPTIONAL_AUTH_KEY, SteamLinkController)).toBeUndefined();

      for (const target of [SteamLinkController, startSignIn, finishSignIn]) {
        expect(Reflect.getMetadata(ALLOW_ANONYMOUS_KEY, target)).toBeUndefined();
      }
    });

    it('puts PoliciesGuard on the class', () => {
      expect(Reflect.getMetadata(GUARDS_METADATA, SteamLinkController)).toEqual([PoliciesGuard]);
    });

    it('lets only a holder of create on UpstreamAccount start', () => {
      const policies = Reflect.getMetadata(CHECK_POLICIES_KEY, startSignIn) as Array<(ability: AppAbility) => boolean>;
      const can = jest.fn();
      const ability = { can } as unknown as AppAbility;

      expect(policies).toHaveLength(1);
      can.mockReturnValue(true);
      expect(policies[0](ability)).toBe(true);
      can.mockReturnValue(false);
      expect(policies[0](ability)).toBe(false);
      expect(can).toHaveBeenCalledWith(Action.create, ResourceType.UpstreamAccount);
    });

    // A policy would refuse a return with no actor before it could be sent
    // back with UPSTREAM_LINK_SESSION_MISMATCH; the session check is the
    // return's own.
    it('puts no policy on the return', () => {
      expect(Reflect.getMetadata(CHECK_POLICIES_KEY, finishSignIn)).toBeUndefined();
    });

    it('sends both routes with Cache-Control: no-store', () => {
      for (const handler of [startSignIn, finishSignIn]) {
        expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
      }
    });

    // The global validation pipe would refuse or coerce Steam's `openid.*`
    // fields, so the return reads the request's raw query, and nothing else.
    it('reads the return from the raw request, never through a @Query() DTO', () => {
      const params = Reflect.getMetadata(ROUTE_ARGS_METADATA, SteamLinkController, 'finishSignIn') as Record<
        string,
        unknown
      >;

      expect(Object.keys(params)).toEqual([`${RouteParamtypes.REQUEST}:0`]);
      expect(Reflect.getMetadata(REDIRECT_METADATA, finishSignIn)).toBeDefined();
    });
  });

  /**
   * Both routes over a real (minimal) Nest HTTP app: the api's global prefix
   * and validation pipe, the edge filter that renders an error answer, and
   * the real link service over fakes of what it calls.
   */
  describe('over HTTP', () => {
    let app: INestApplication;
    let base: string;
    const pending = new Map<string, PendingSteamSignIn>();
    const getActor = jest.fn<Actor | null, []>();
    const start = jest.fn(async (input: Omit<PendingSteamSignIn, 'createdAt'>) => {
      const state = `state_${String(pending.size + 1).padStart(26, '0')}`;
      pending.set(state, { ...input, createdAt: new Date().toISOString() });

      return { state, expiresAt: new Date('2026-11-19T12:30:00.000Z') };
    });
    const take = jest.fn(async (state: string) => {
      const found = pending.get(state) ?? null;
      pending.delete(state);

      return found;
    });
    const verify = jest.fn<Promise<SteamVerification>, [Readonly<Record<string, unknown>>, string]>();
    const create = jest.fn();

    beforeAll(async () => {
      const module = await Test.createTestingModule({
        controllers: [SteamLinkController],
        providers: [
          SteamLinkService,
          { provide: ConfigService, useValue: new ConfigService({ auth: { url: 'https://bge.example' } }) },
          { provide: SteamSignInStore, useValue: { start, take } },
          { provide: SteamOpenIdVerifier, useValue: { verify } },
          {
            provide: AuthService,
            useValue: { isTrustedReturnAddress: async (url: string) => new URL(url).origin === 'https://app.example' },
          },
          {
            provide: UpstreamAccountService,
            useValue: {
              linkableUpstreams: async () => [Upstream.Steam],
              assertNotLinked: async () => undefined,
              privacyPolicy: async () => policy,
              create,
            },
          },
          { provide: AuditContextService, useValue: { getActor, getLocale: () => 'en' } },
          { provide: I18nService, useValue: { translate: (key: string) => `rendered:${key}` } },
          { provide: LocaleResolutionService, useValue: { resolveAcceptLanguage: () => 'en' } },
          { provide: APP_FILTER, useClass: I18nExceptionFilter },
        ],
      })
        .overrideGuard(PoliciesGuard)
        .useValue({ canActivate: () => true })
        .compile();

      app = module.createNestApplication();
      // As main.ts sets them up.
      app.setGlobalPrefix('api');
      app.useGlobalPipes(
        new I18nValidationPipe({
          forbidNonWhitelisted: true,
          transform: true,
          whitelist: true,
          validationError: { target: false, value: false },
          transformOptions: { enableImplicitConversion: true },
        }),
      );
      await app.listen(0);
      base = await app.getUrl();
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => {
      pending.clear();
      jest.clearAllMocks();
      getActor.mockReturnValue(user);
      verify.mockResolvedValue({ ok: true, steamId: STEAM_ID });
      create.mockResolvedValue({});
    });

    const startSignIn = (body: unknown) =>
      fetch(`${base}/api/users/me/upstream-accounts/steam/sign-in`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    /** Starts a sign-in as the current actor, and answers the return address it sent Steam. */
    const started = async (): Promise<URL> => {
      const answer = await startSignIn({ returnTo: RETURN_TO });
      expect(answer.status).toBe(HttpStatus.CREATED);
      const { signIn } = (await answer.json()) as { signIn: { url: string } };

      return new URL(String(new URL(signIn.url).searchParams.get('openid.return_to')));
    };

    /** Steam's browser redirect back to `returnUrl`, with an answer's fields added to its query. */
    const comeBack = (returnUrl: URL, extra: Record<string, string> = {}) => {
      const address = new URL(`${returnUrl.pathname}${returnUrl.search}`, base);
      address.searchParams.set('openid.ns', OPENID_2_NAMESPACE);
      address.searchParams.set('openid.mode', 'id_res');
      address.searchParams.set('openid.claimed_id', `https://steamcommunity.com/openid/id/${STEAM_ID}`);
      for (const [key, value] of Object.entries(extra)) {
        address.searchParams.set(key, value);
      }

      return fetch(address, { redirect: 'manual' });
    };

    it('starts a sign-in for a signed-in user, uncached', async () => {
      const answer = await startSignIn({ returnTo: RETURN_TO });

      expect(answer.status).toBe(HttpStatus.CREATED);
      expect(answer.headers.get('cache-control')).toBe('no-store');
      const { signIn } = (await answer.json()) as {
        signIn: { expiresAt: string; privacyPolicy: unknown; url: string };
      };
      expect(signIn.expiresAt).toBe('2026-11-19T12:30:00.000Z');
      expect(signIn.privacyPolicy).toEqual(policy);
      expect(new URL(signIn.url).searchParams.get('openid.realm')).toBe('https://bge.example');
      expect(start).toHaveBeenCalledWith({ userId: ME, returnTo: RETURN_TO });
    });

    // Only a registered user's own session can be found again at the return:
    // a key's request carries none, and the return refuses an anonymous user's
    // (#935).
    it.each<[string, Actor]>([
      ['an API key', { kind: 'apiKey', apiKeyId: 'key-1', userId: ME }],
      ['an anonymous user', { kind: 'anonymous', userId: ME }],
    ])('refuses to start for %s with 403', async (_, actor) => {
      getActor.mockReturnValue(actor);

      const answer = await startSignIn({ returnTo: RETURN_TO });

      expect(answer.status).toBe(HttpStatus.FORBIDDEN);
      expect(start).not.toHaveBeenCalled();
    });

    it.each([
      ['a return address longer than 2048 characters', { returnTo: `https://app.example/${'a'.repeat(2048)}` }],
      ['no return address', {}],
      ['a return address that is not a string', { returnTo: 42 }],
      ['an unknown field', { returnTo: RETURN_TO, upstream: 'boardgamegeek' }],
    ])('refuses a body with %s', async (_, body) => {
      const answer = await startSignIn(body);

      expect(answer.status).toBe(HttpStatus.BAD_REQUEST);
      expect(start).not.toHaveBeenCalled();
    });

    it("redirects to the client's address, uncached, with the result, whatever else the query says", async () => {
      const returnUrl = await started();

      const back = await comeBack(returnUrl, {
        returnTo: 'https://evil.example/',
        upstreamAccount: 'boardgamegeek',
        error: 'FORGED',
      });

      expect(back.status).toBe(HttpStatus.FOUND);
      expect(back.headers.get('location')).toBe(`${RETURN_TO}&upstreamAccount=steam&result=linked`);
      expect(back.headers.get('cache-control')).toBe('no-store');
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ userId: ME, externalId: STEAM_ID, verified: true }),
      );
    });

    // Steam's dotted `openid.*` names, and anything else on the query, reach
    // the verifier as sent: the global validation pipe never sees them.
    it('hands the verifier the raw query and the return address the start sent Steam', async () => {
      const returnUrl = await started();

      await comeBack(returnUrl, { 'openid.sig': 'c2lnbmF0dXJl', extra: '1' });

      expect(verify).toHaveBeenCalledWith(
        expect.objectContaining({
          state: returnUrl.searchParams.get('state'),
          'openid.ns': OPENID_2_NAMESPACE,
          'openid.mode': 'id_res',
          'openid.sig': 'c2lnbmF0dXJl',
          extra: '1',
        }),
        returnUrl.toString(),
      );
    });

    it('answers an unknown state with a 400 error answer, uncached, and no redirect', async () => {
      const returnUrl = await started();
      await comeBack(returnUrl);

      const again = await comeBack(returnUrl);

      expect(again.status).toBe(HttpStatus.BAD_REQUEST);
      expect(again.headers.get('location')).toBeNull();
      expect(again.headers.get('cache-control')).toBe('no-store');
      await expect(again.json()).resolves.toEqual({
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        code: 'UPSTREAM_LINK_EXPIRED',
        message: 'rendered:errors.upstream_account.link_expired',
      });
    });

    it('answers a repeated state as no state, taking none', async () => {
      const returnUrl = await started();
      const state = String(returnUrl.searchParams.get('state'));
      const address = new URL(STEAM_RETURN_PATH, base);
      address.searchParams.append('state', state);
      address.searchParams.append('state', state);

      const back = await fetch(address, { redirect: 'manual' });

      expect(back.status).toBe(HttpStatus.BAD_REQUEST);
      expect(take).not.toHaveBeenCalled();
    });

    it.each<[string, Actor | null]>([
      ['no session', null],
      ['an API key', { kind: 'apiKey', apiKeyId: 'key-1', userId: ME }],
      ['an anonymous user', { kind: 'anonymous', userId: ME }],
      ["another user's session", { kind: 'user', userId: 'user-2' }],
    ])('sends a return with %s back with UPSTREAM_LINK_SESSION_MISMATCH, linking nothing', async (_, actor) => {
      const returnUrl = await started();
      getActor.mockReturnValue(actor);

      const back = await comeBack(returnUrl);

      expect(back.status).toBe(HttpStatus.FOUND);
      expect(back.headers.get('location')).toBe(
        `${RETURN_TO}&upstreamAccount=steam&error=UPSTREAM_LINK_SESSION_MISMATCH`,
      );
      expect(verify).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });
  });
});
