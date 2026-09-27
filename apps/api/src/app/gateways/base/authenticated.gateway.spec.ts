import { AuthService } from '@bge/auth';
import type { I18nTranslations, LocaleResolutionService } from '@bge/i18n';
import { Logger } from '@nestjs/common';
import type { I18nService } from 'nestjs-i18n';
import type { Namespace, Socket } from 'socket.io';
import { WsConnectionRefusal } from '../filters';
import { AuthenticatedGateway } from './authenticated.gateway';
import type { WsFrameScope } from './ws-frame-scope';
import { WsTranslator } from './ws-translator';

class TestGateway extends AuthenticatedGateway {
  protected readonly logger = new Logger(TestGateway.name);
}

class OtherTestGateway extends AuthenticatedGateway {
  protected readonly logger = new Logger(OtherTestGateway.name);
}

type Middleware = (client: Socket, next: (error?: Error) => void) => void;

/** A namespace that records the middleware gateways register on it. */
function fakeNamespace(): { namespace: Namespace; middleware: Middleware[] } {
  const middleware: Middleware[] = [];
  const namespace = { use: (fn: Middleware) => middleware.push(fn) } as unknown as Namespace;

  return { namespace, middleware };
}

/** Runs a connection through every middleware, in order, until one refuses it. */
async function handshake(middleware: Middleware[], client: Socket): Promise<Error | undefined> {
  for (const fn of middleware) {
    const refusal = await new Promise<Error | undefined>((next) => fn(client, next));
    if (refusal) {
      return refusal;
    }
  }

  return undefined;
}

const frameScope = { bind: jest.fn() } as unknown as WsFrameScope;

const connection = ({
  token = 'token-1',
  acceptLanguage,
}: { token?: string | null; acceptLanguage?: string } = {}): Socket =>
  ({
    id: 'socket-1',
    handshake: {
      auth: token === null ? {} : { token },
      headers: acceptLanguage ? { 'accept-language': acceptLanguage } : {},
    },
    data: {},
    onAny: jest.fn(),
  }) as unknown as Socket;

/** An auth service whose every token looks up `session`. */
const authServiceFor = (session: unknown, valid = true) =>
  ({
    getSessionFromToken: jest.fn().mockResolvedValue(session),
    isValidSession: () => valid,
  }) as unknown as AuthService;

describe('AuthenticatedGateway', () => {
  let resolve: jest.Mock;
  let translator: WsTranslator;

  beforeEach(() => {
    resolve = jest.fn().mockResolvedValue('fr');
    // Names the key and the locale it was asked for, so a test reads both.
    const i18n = { translate: (key: string, { lang }: { lang: string }) => `${lang}:${key}` };
    translator = new WsTranslator(
      { resolve } as unknown as LocaleResolutionService,
      i18n as unknown as I18nService<I18nTranslations>,
    );
  });

  afterEach(() => jest.restoreAllMocks());

  it('refuses a connection whose session cannot be looked up with a 500, and logs why', async () => {
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const outage = new Error('connect ECONNREFUSED redis:6379');
    const authService = { getSessionFromToken: jest.fn().mockRejectedValue(outage) } as unknown as AuthService;
    const { namespace, middleware } = fakeNamespace();

    new TestGateway(authService, frameScope, translator).afterInit(namespace);
    const refusal = await handshake(middleware, connection());

    // The client reads the message and `data` on `connect_error`; neither
    // names the cause. Like Nest's own 500 over HTTP, it is not translated.
    expect(refusal).toBeInstanceOf(WsConnectionRefusal);
    expect(refusal).toMatchObject({
      message: 'Internal server error',
      data: { statusCode: 500, error: 'Internal Server Error', message: 'Internal server error' },
    });
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('socket-1'), outage);
  });

  it("looks up a connection's session once, however many gateways share its namespace", async () => {
    const getSessionFromToken = jest.fn().mockResolvedValue(null);
    const authService = { getSessionFromToken, isValidSession: () => false } as unknown as AuthService;
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { namespace, middleware } = fakeNamespace();

    new TestGateway(authService, frameScope, translator).afterInit(namespace);
    new OtherTestGateway(authService, frameScope, translator).afterInit(namespace);
    await handshake(middleware, connection());

    expect(getSessionFromToken).toHaveBeenCalledTimes(1);
  });

  describe('the locale', () => {
    it("stores the connection's locale, from its user's preference and the handshake's Accept-Language", async () => {
      const authService = authServiceFor({ user: { id: 'user-1', isAnonymous: false }, session: {} });
      const { namespace, middleware } = fakeNamespace();
      const client = connection({ acceptLanguage: 'fr-CA,fr;q=0.9' });

      new TestGateway(authService, frameScope, translator).afterInit(namespace);

      await expect(handshake(middleware, client)).resolves.toBeUndefined();
      expect(resolve).toHaveBeenCalledWith({ userId: 'user-1', acceptLanguage: 'fr-CA,fr;q=0.9' });
      expect(client.data).toMatchObject({ userId: 'user-1', locale: 'fr' });
    });

    it('connects in the fallback locale when its locale cannot be resolved, and logs why', async () => {
      const warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      resolve.mockRejectedValue(new Error('supported locales not loaded'));
      const authService = authServiceFor({ user: { id: 'user-1', isAnonymous: false }, session: {} });
      const { namespace, middleware } = fakeNamespace();
      const client = connection();

      new TestGateway(authService, frameScope, translator).afterInit(namespace);

      await expect(handshake(middleware, client)).resolves.toBeUndefined();
      expect(client.data).toMatchObject({ locale: 'en' });
      expect(warned).toHaveBeenCalledWith(expect.stringContaining('socket-1'), expect.anything());
    });
  });

  describe('a refusal', () => {
    beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));

    it.each([
      [
        'no token',
        connection({ token: null, acceptLanguage: 'fr' }),
        authServiceFor(null),
        401,
        'errors.auth.no_token',
      ],
      [
        'an expired or invalid session',
        connection({ acceptLanguage: 'fr' }),
        authServiceFor(null, false),
        401,
        'errors.auth.session_invalid',
      ],
      [
        'a session with no user',
        connection({ acceptLanguage: 'fr' }),
        authServiceFor({ session: {} }),
        403,
        'errors.auth.session_unresolved',
      ],
      [
        'an anonymous session',
        connection({ acceptLanguage: 'fr' }),
        authServiceFor({ user: { id: 'anon-1', isAnonymous: true }, session: {} }),
        403,
        'errors.auth.anonymous_not_permitted',
      ],
      [
        'an impersonated session',
        connection({ acceptLanguage: 'fr' }),
        authServiceFor({ user: { id: 'target-1' }, session: { impersonatedBy: 'admin-1' } }),
        403,
        'errors.auth.impersonated_session',
      ],
    ])(
      "names why for %s, in the handshake's Accept-Language and no stored preference",
      async (_, client, authService, statusCode, key) => {
        const { namespace, middleware } = fakeNamespace();

        new TestGateway(authService, frameScope, translator).afterInit(namespace);
        const refusal = await handshake(middleware, client);

        expect(refusal).toBeInstanceOf(WsConnectionRefusal);
        expect(refusal).toMatchObject({
          message: `fr:${key}`,
          data: { statusCode, message: `fr:${key}` },
        });
        expect(resolve).toHaveBeenCalledWith({ acceptLanguage: 'fr' });
      },
    );

    it('is still sent, with its status, when its copy cannot be rendered, and logs why', async () => {
      const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const malformed = new Error('cannot switch from implicit to explicit numbering');
      const i18n = {
        translate: () => {
          throw malformed;
        },
      };
      const broken = new WsTranslator(
        { resolve } as unknown as LocaleResolutionService,
        i18n as unknown as I18nService<I18nTranslations>,
      );
      const { namespace, middleware } = fakeNamespace();

      new TestGateway(authServiceFor(null), frameScope, broken).afterInit(namespace);
      const refusal = await handshake(middleware, connection({ token: null }));

      expect(refusal).toMatchObject({
        message: 'errors.auth.no_token',
        data: { statusCode: 401, message: 'errors.auth.no_token' },
      });
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('errors.auth.no_token'), malformed.stack);
    }, 1_000);
  });
});
