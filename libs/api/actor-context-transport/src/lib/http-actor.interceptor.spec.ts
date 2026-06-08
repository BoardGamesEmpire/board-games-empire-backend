import { AuditContextService } from '@bge/actor-context';
import {
  ACTOR_CLS_KEY,
  AuditContextInternalService,
  CORRELATION_ID_CLS_KEY,
  SOURCE_CLS_KEY,
} from '@bge/actor-context/internal';
import { AuthService } from '@bge/auth';
import { ExecutionContext, Logger, UnauthorizedException } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';
import type { Request } from 'express';
import { ClsModule, ClsService } from 'nestjs-cls';
import { firstValueFrom, of } from 'rxjs';

import { API_KEY_HEADER, HttpActorInterceptor } from './http-actor.interceptor';

type UserSession = NonNullable<Awaited<ReturnType<AuthService['getSessionFromHeaders']>>>;

const stubSession = (userOverrides: { id: string; isAnonymous: boolean }, sessionId: string): UserSession => {
  const now = new Date(0);
  return {
    user: {
      id: userOverrides.id,
      isAnonymous: userOverrides.isAnonymous,
      email: '',
      emailVerified: false,
      name: '',
      createdAt: now,
      updatedAt: now,
    } as UserSession['user'],
    session: {
      id: sessionId,
      userId: userOverrides.id,
      token: 'stub-token',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + 86_400_000),
    } as UserSession['session'],
  };
};

type AuthMock = jest.Mocked<Pick<AuthService, 'verifyApiKey' | 'getSessionFromHeaders' | 'hasSessionCredential'>>;

const buildAuthMock = (): AuthMock =>
  ({
    verifyApiKey: jest.fn(),
    getSessionFromHeaders: jest.fn(),
    hasSessionCredential: jest.fn().mockReturnValue(false),
  }) satisfies AuthMock;

const buildRequest = (headers: Record<string, string | string[] | undefined> = {}): Request =>
  ({
    headers,
  }) as unknown as Request;

type HttpArgumentsHost = ReturnType<ExecutionContext['switchToHttp']>;

const stubHttpHost = (request: Request): HttpArgumentsHost => ({
  getRequest: <T>() => request as T,
  getResponse: <T>() => ({}) as T,
  getNext: <T>() => undefined as T,
});

const buildExecutionContext = (request: Request): ExecutionContext =>
  ({
    switchToHttp: () => stubHttpHost(request),
    getType: <T extends string>() => 'http' as T,
  }) satisfies Partial<ExecutionContext> as ExecutionContext;

interface Captured {
  readonly actor: unknown;
  readonly correlationId: unknown;
  readonly source: unknown;
}

describe('HttpActorInterceptor', () => {
  let module: TestingModule;
  let interceptor: HttpActorInterceptor;
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
        HttpActorInterceptor,
      ],
    }).compile();

    interceptor = module.get(HttpActorInterceptor);
    cls = module.get(ClsService);
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
  });

  afterEach(async () => {
    warnSpy.mockRestore();
    await module.close();
  });

  /**
   * Drives the interceptor inside an active CLS scope and captures the values
   * that landed on CLS after population.
   */
  const run = async (request: Request): Promise<Captured> => {
    let captured: Captured = {
      actor: undefined,
      correlationId: undefined,
      source: undefined,
    };

    await cls.run(async () => {
      const result$ = await interceptor.intercept(buildExecutionContext(request), { handle: () => of('next-result') });
      await firstValueFrom(result$);
      captured = {
        actor: cls.get(ACTOR_CLS_KEY),
        correlationId: cls.get(CORRELATION_ID_CLS_KEY),
        source: cls.get(SOURCE_CLS_KEY),
      };
    });

    return captured;
  };

  describe('unauthenticated requests', () => {
    it('populates null actor and skips getSession when no session credential and no api key', async () => {
      authMock.getSessionFromHeaders.mockResolvedValue(null);

      const captured = await run(buildRequest());

      expect(captured.actor).toBeNull();
      expect(captured.source).toBe('http');
      expect(captured.correlationId).toMatch(/^[0-9a-f-]{36}$/);
      expect(authMock.verifyApiKey).not.toHaveBeenCalled();
      // No session credential present → the expensive getSession lookup is skipped.
      expect(authMock.getSessionFromHeaders).not.toHaveBeenCalled();
    });
  });

  describe('session path', () => {
    // A request reaches the session lookup only when a session credential is
    // present; hasSessionCredential gates the expensive getSession call.
    beforeEach(() => authMock.hasSessionCredential.mockReturnValue(true));

    it('populates a user actor for a non-anonymous session', async () => {
      authMock.getSessionFromHeaders.mockResolvedValue(stubSession({ id: 'user-1', isAnonymous: false }, 'sess-1'));

      const captured = await run(buildRequest({ cookie: 'bge_auth_.session_token=abc123' }));

      expect(captured.actor).toEqual({ kind: 'user', userId: 'user-1' });
      expect(authMock.verifyApiKey).not.toHaveBeenCalled();
    });

    it('populates an anonymous actor when isAnonymous=true', async () => {
      authMock.getSessionFromHeaders.mockResolvedValue(stubSession({ id: 'anon-1', isAnonymous: true }, 'sess-2'));

      const captured = await run(buildRequest({ cookie: 'bge_auth_.session_token=zzz' }));

      expect(captured.actor).toEqual({
        kind: 'anonymous',
        userId: 'anon-1',
      });
    });

    it('populates null actor when getSessionFromHeaders returns null', async () => {
      authMock.getSessionFromHeaders.mockResolvedValue(null);

      const captured = await run(buildRequest({ cookie: 'bge_auth_.session_token=expired' }));

      expect(captured.actor).toBeNull();
    });

    it('also works with Bearer-token auth (delegated to AuthService)', async () => {
      authMock.getSessionFromHeaders.mockResolvedValue(
        stubSession({ id: 'user-bearer', isAnonymous: false }, 'sess-bearer'),
      );

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
      expect(authMock.verifyApiKey).toHaveBeenCalledWith('secret');
      expect(authMock.getSessionFromHeaders).not.toHaveBeenCalled();
    });

    it('throws UnauthorizedException when AuthService returns null', async () => {
      authMock.verifyApiKey.mockResolvedValue(null);

      await expect(run(buildRequest({ [API_KEY_HEADER]: 'nope' }))).rejects.toBeInstanceOf(UnauthorizedException);
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

    it('prefers api key and logs a warning when bearer token also present', async () => {
      authMock.hasSessionCredential.mockReturnValue(true);
      authMock.verifyApiKey.mockResolvedValue({
        id: 'key-2',
        userId: 'user-2',
      });

      await run(
        buildRequest({
          [API_KEY_HEADER]: 'secret',
          authorization: 'Bearer also-here',
        }),
      );

      expect(warnSpy).toHaveBeenCalled();
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
