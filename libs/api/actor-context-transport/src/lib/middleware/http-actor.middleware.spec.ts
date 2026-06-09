import {
  ACTOR_CLS_KEY,
  AuditContextInternalService,
  AuditContextService,
  CORRELATION_ID_CLS_KEY,
  SOURCE_CLS_KEY,
} from '@bge/actor-context';
import { AuthService } from '@bge/auth';
import { Logger, UnauthorizedException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import type { NextFunction, Request, Response } from 'express';
import { ClsModule, ClsService } from 'nestjs-cls';
import { API_KEY_HEADER, HttpActorMiddleware } from './http-actor.middleware';

type AuthMock = jest.Mocked<Pick<AuthService, 'verifyApiKey' | 'getSessionFromHeaders' | 'hasSessionCredential'>>;

const buildAuthMock = (): AuthMock =>
  ({
    verifyApiKey: jest.fn(),
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
      // CLS was not populated because populate is reached after resolveActor.
      expect(captured.actor).toBeUndefined();
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
