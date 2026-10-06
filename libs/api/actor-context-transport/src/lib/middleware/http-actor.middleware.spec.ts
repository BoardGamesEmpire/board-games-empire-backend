import {
  ACTOR_CLS_KEY,
  AuditContextInternalService,
  AuditContextService,
  CORRELATION_ID_CLS_KEY,
  SOURCE_CLS_KEY,
} from '@bge/actor-context';
import { AuthService, type AuthUser } from '@bge/auth';
import { I18nMessage, t } from '@bge/i18n';
import { ForbiddenException, Logger, UnauthorizedException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import type { NextFunction, Request, Response } from 'express';
import { ClsModule, ClsService } from 'nestjs-cls';
import { API_KEY_HEADER, HttpActorMiddleware } from './http-actor.middleware';

type AuthMock = jest.Mocked<
  Pick<AuthService, 'verifyApiKey' | 'findUserById' | 'getSessionFromHeaders' | 'hasSessionCredential'>
>;

/** A key's owner as `findUserById` returns one; unbanned unless the test says otherwise. */
const owner = (ban: { banned?: boolean | null; banExpires?: Date | null } = {}): AuthUser =>
  ({ id: 'user-9', banned: false, banExpires: null, ...ban }) as unknown as AuthUser;

const buildAuthMock = (): AuthMock =>
  ({
    verifyApiKey: jest.fn(),
    findUserById: jest.fn().mockResolvedValue(owner()),
    getSessionFromHeaders: jest.fn(),
    hasSessionCredential: jest.fn().mockReturnValue(false),
  }) satisfies AuthMock;

const buildRequest = (headers: Record<string, string | string[] | undefined> = {}): Request =>
  ({ headers }) as unknown as Request;

const buildResponse = (): Response => ({}) as unknown as Response;

interface Captured {
  readonly actor: unknown;
  readonly correlationId: unknown;
  readonly source: unknown;
  readonly nextArg: unknown;
}

describe('HttpActorMiddleware', () => {
  let module: TestingModule;
  let middleware: HttpActorMiddleware;
  let cls: ClsService;
  let authMock: AuthMock;
  let warnSpy: jest.SpyInstance;

  beforeEach(async () => {
    authMock = buildAuthMock();

    module = await Test.createTestingModule({
      imports: [ClsModule.forRoot({ global: true, middleware: { mount: false } })],
      providers: [
        AuditContextService,
        AuditContextInternalService,
        { provide: AuthService, useValue: authMock },
        HttpActorMiddleware,
      ],
    }).compile();

    middleware = module.get(HttpActorMiddleware);
    cls = module.get(ClsService);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await module.close();
  });

  /**
   * Drives the middleware inside a CLS scope (mimicking ClsMiddleware having
   * run first). Captures CLS state + the argument next() was called with.
   */
  const run = async (request: Request): Promise<Captured> => {
    let captured: Captured = {
      actor: undefined,
      correlationId: undefined,
      source: undefined,
      nextArg: undefined,
    };

    await cls.run(async () => {
      const next: NextFunction = (arg) => {
        captured = {
          actor: cls.get(ACTOR_CLS_KEY),
          correlationId: cls.get(CORRELATION_ID_CLS_KEY),
          source: cls.get(SOURCE_CLS_KEY),
          nextArg: arg,
        };
      };

      await middleware.use(request, buildResponse(), next);
    });

    return captured;
  };

  describe('unauthenticated requests', () => {
    it('populates null actor when no session and no api key', async () => {
      authMock.getSessionFromHeaders.mockResolvedValue(null);

      const captured = await run(buildRequest());

      expect(captured.actor).toBeNull();
      expect(captured.source).toBe('http');
      expect(captured.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(captured.nextArg).toBeUndefined();
      expect(authMock.verifyApiKey).not.toHaveBeenCalled();
    });
  });

  describe('session path', () => {
    // A request reaches the session lookup only when a session credential is
    // present; hasSessionCredential gates the expensive getSession call.
    beforeEach(() => authMock.hasSessionCredential.mockReturnValue(true));

    it('populates a user actor for a non-anonymous session', async () => {
      authMock.getSessionFromHeaders.mockResolvedValue({
        user: { id: 'user-1', isAnonymous: false } as unknown as UserSession['user'],
        session: { id: 'sess-1', userId: 'user-1' },
      } as Awaited<ReturnType<AuthService['getSessionFromHeaders']>>);

      const captured = await run(buildRequest({ cookie: 'bge_auth_session_token=abc123' }));

      expect(captured.actor).toEqual({ kind: 'user', userId: 'user-1' });
      expect(captured.nextArg).toBeUndefined();
    });

    it('populates an anonymous actor when isAnonymous=true', async () => {
      authMock.getSessionFromHeaders.mockResolvedValue({
        user: { id: 'anon-1', isAnonymous: true } as unknown as UserSession['user'],
        session: { id: 'sess-2', userId: 'anon-1' },
      } as Awaited<ReturnType<AuthService['getSessionFromHeaders']>>);

      const captured = await run(buildRequest({ cookie: 'bge_auth_session_token=zzz' }));

      expect(captured.actor).toEqual({
        kind: 'anonymous',
        userId: 'anon-1',
      });
    });

    it('also works with Bearer-token auth (delegated to AuthService)', async () => {
      authMock.getSessionFromHeaders.mockResolvedValue({
        user: { id: 'user-bearer', isAnonymous: false } as unknown as UserSession['user'],
        session: { id: 'sess-bearer', userId: 'user-bearer' },
      } as Awaited<ReturnType<AuthService['getSessionFromHeaders']>>);

      const captured = await run(buildRequest({ authorization: 'Bearer xyz' }));

      expect(captured.actor).toEqual({
        kind: 'user',
        userId: 'user-bearer',
      });
    });
  });

  describe('impersonated sessions', () => {
    beforeEach(() => authMock.hasSessionCredential.mockReturnValue(true));

    const impersonated = (): Awaited<ReturnType<AuthService['getSessionFromHeaders']>> =>
      ({
        user: { id: 'target-1', isAnonymous: false } as unknown as UserSession['user'],
        session: { id: 'sess-imp', userId: 'target-1', impersonatedBy: 'admin-1' },
        // `impersonatedBy` is absent from the adapter's session type (the
        // admin plugin adds the column), so the cast needs the `unknown` hop.
      }) as unknown as Awaited<ReturnType<AuthService['getSessionFromHeaders']>>;

    it('refuses the request rather than minting an actor for the target user', async () => {
      authMock.getSessionFromHeaders.mockResolvedValue(impersonated());

      const captured = await run(buildRequest({ authorization: 'Bearer imp' }));

      expect(captured.nextArg).toBeInstanceOf(ForbiddenException);
      expect((captured.nextArg as ForbiddenException).getResponse()).toEqual(t('errors.auth.impersonated_session'));
      // Never populated: an actor of `{ kind: 'user', userId: 'target-1' }`
      // is precisely the audit-attribution hole this guard closes.
      expect(captured.actor).toBeUndefined();
    });

    it('does not leak the acting admin to the caller', async () => {
      authMock.getSessionFromHeaders.mockResolvedValue(impersonated());

      const captured = await run(buildRequest({ authorization: 'Bearer imp' }));

      // The caller sees only the rendered catalog copy. A marker with no args
      // has nothing from the session to interpolate into it.
      const body = (captured.nextArg as ForbiddenException).getResponse() as I18nMessage;
      expect(body).toBeInstanceOf(I18nMessage);
      expect(body.args).toBeUndefined();
    });

    it('logs the acting admin and the target so the attempt is traceable', async () => {
      authMock.getSessionFromHeaders.mockResolvedValue(impersonated());

      await run(buildRequest({ authorization: 'Bearer imp' }));

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('admin-1'));
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('target-1'));
    });

    it('refuses a session whose impersonatedBy is present but empty', async () => {
      // Fails open if the helper reads `''` as absent.
      authMock.getSessionFromHeaders.mockResolvedValue({
        user: { id: 'target-1', isAnonymous: false } as unknown as UserSession['user'],
        session: { id: 'sess-imp', userId: 'target-1', impersonatedBy: '' },
      } as unknown as Awaited<ReturnType<AuthService['getSessionFromHeaders']>>);

      const captured = await run(buildRequest({ authorization: 'Bearer imp' }));

      expect(captured.nextArg).toBeInstanceOf(ForbiddenException);
      expect(captured.actor).toBeUndefined();
    });

    it('admits an ordinary session whose impersonatedBy is null', async () => {
      authMock.getSessionFromHeaders.mockResolvedValue({
        user: { id: 'user-1', isAnonymous: false } as unknown as UserSession['user'],
        session: { id: 'sess-1', userId: 'user-1', impersonatedBy: null },
      } as unknown as Awaited<ReturnType<AuthService['getSessionFromHeaders']>>);

      const captured = await run(buildRequest({ authorization: 'Bearer ok' }));

      expect(captured.actor).toEqual({ kind: 'user', userId: 'user-1' });
      expect(captured.nextArg).toBeUndefined();
    });
  });

  describe('api key path', () => {
    it('populates an apiKey actor on successful verification', async () => {
      authMock.verifyApiKey.mockResolvedValue({
        id: 'key-1',
        userId: 'user-9',
      });

      const captured = await run(buildRequest({ [API_KEY_HEADER]: 'secret' }));

      expect(captured.actor).toEqual({
        kind: 'apiKey',
        apiKeyId: 'key-1',
        userId: 'user-9',
      });
      expect(captured.nextArg).toBeUndefined();
      expect(authMock.verifyApiKey).toHaveBeenCalledWith('secret');
      expect(authMock.getSessionFromHeaders).not.toHaveBeenCalled();
    });

    it('forwards UnauthorizedException to next when AuthService returns null', async () => {
      authMock.verifyApiKey.mockResolvedValue(null);

      const captured = await run(buildRequest({ [API_KEY_HEADER]: 'nope' }));

      expect(captured.nextArg).toBeInstanceOf(UnauthorizedException);
      expect((captured.nextArg as UnauthorizedException).getResponse()).toEqual(t('errors.api_key.invalid'));
      // CLS was not populated because populate is reached after resolveActor.
      expect(captured.actor).toBeUndefined();
    });

    describe("the key's owner", () => {
      const DAY_MS = 24 * 60 * 60 * 1000;

      beforeEach(() => authMock.verifyApiKey.mockResolvedValue({ id: 'key-1', userId: 'user-9' }));

      it.each<[string, AuthUser]>([
        ['banned with no expiry', owner({ banned: true, banExpires: null })],
        ['banned until tomorrow', owner({ banned: true, banExpires: new Date(Date.now() + DAY_MS) })],
      ])('refuses the key with a 403 when its owner is %s', async (_, banned) => {
        authMock.findUserById.mockResolvedValue(banned);

        const captured = await run(buildRequest({ [API_KEY_HEADER]: 'secret' }));

        expect(authMock.findUserById).toHaveBeenCalledWith('user-9');
        expect(captured.nextArg).toBeInstanceOf(ForbiddenException);
        expect((captured.nextArg as ForbiddenException).getResponse()).toEqual(t('errors.api_key.owner_banned'));
        expect(captured.actor).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/key-1.*user-9.*banned/));
      });

      it.each<[string, AuthUser]>([
        ['whose ban expired yesterday', owner({ banned: true, banExpires: new Date(Date.now() - DAY_MS) })],
        ['whose ban flag is unset', owner({ banned: null })],
      ])('admits the key of an owner %s', async (_, unbanned) => {
        authMock.findUserById.mockResolvedValue(unbanned);

        const captured = await run(buildRequest({ [API_KEY_HEADER]: 'secret' }));

        expect(captured.actor).toEqual({ kind: 'apiKey', apiKeyId: 'key-1', userId: 'user-9' });
        expect(captured.nextArg).toBeUndefined();
      });

      it('reads the owner on every request, so a ban stops the key on its next one', async () => {
        authMock.findUserById.mockResolvedValueOnce(owner()).mockResolvedValueOnce(owner({ banned: true }));

        const before = await run(buildRequest({ [API_KEY_HEADER]: 'secret' }));
        const after = await run(buildRequest({ [API_KEY_HEADER]: 'secret' }));

        expect(before.nextArg).toBeUndefined();
        expect(after.nextArg).toBeInstanceOf(ForbiddenException);
      });

      it('refuses the key as invalid when its owner no longer exists', async () => {
        authMock.findUserById.mockResolvedValue(null);

        const captured = await run(buildRequest({ [API_KEY_HEADER]: 'secret' }));

        expect(captured.nextArg).toBeInstanceOf(UnauthorizedException);
        expect((captured.nextArg as UnauthorizedException).getResponse()).toEqual(t('errors.api_key.invalid'));
        expect(captured.actor).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/key-1.*user-9/));
      });
    });
  });

  describe('both credentials present', () => {
    it('prefers api key and logs a warning when session cookie also present', async () => {
      authMock.hasSessionCredential.mockReturnValue(true);
      authMock.verifyApiKey.mockResolvedValue({
        id: 'key-1',
        userId: 'user-1',
      });

      const captured = await run(
        buildRequest({
          [API_KEY_HEADER]: 'secret',
          cookie: 'bge_auth_session_token=also-here',
        }),
      );

      expect(captured.actor).toEqual({
        kind: 'apiKey',
        apiKeyId: 'key-1',
        userId: 'user-1',
      });
      expect(authMock.getSessionFromHeaders).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/both.*x-api-key.*session credential/i));
    });

    it('does not warn when only the api key is present', async () => {
      authMock.hasSessionCredential.mockReturnValue(false);
      authMock.verifyApiKey.mockResolvedValue({
        id: 'key-3',
        userId: 'user-3',
      });

      await run(buildRequest({ [API_KEY_HEADER]: 'only-key' }));

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe('correlation id resolution', () => {
    beforeEach(() => authMock.getSessionFromHeaders.mockResolvedValue(null));

    it('uses traceparent trace_id when valid', async () => {
      const captured = await run(
        buildRequest({
          traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        }),
      );
      expect(captured.correlationId).toBe('0af7651916cd43dd8448eb211c80319c');
    });

    it('falls back to x-correlation-id when traceparent is invalid', async () => {
      const captured = await run(
        buildRequest({
          traceparent: 'malformed',
          'x-correlation-id': 'corr-explicit',
        }),
      );
      expect(captured.correlationId).toBe('corr-explicit');
    });

    it('generates a UUID when neither header is present', async () => {
      const captured = await run(buildRequest());
      expect(captured.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });
  });

  describe('source', () => {
    it('always populates source as http', async () => {
      authMock.getSessionFromHeaders.mockResolvedValue(null);
      const captured = await run(buildRequest());
      expect(captured.source).toBe('http');
    });
  });
});
