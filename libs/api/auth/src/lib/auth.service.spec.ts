import type { UserSession } from '@thallesp/nestjs-better-auth';
import { betterAuth } from 'better-auth';
import type { IncomingHttpHeaders } from 'node:http';
import type { authFactory } from './auth-factory';
import { AuthService } from './auth.service';
import { AUTH_COOKIE_PREFIX } from './constants';

const TRUSTED = 'https://app.example';
const UNTRUSTED = 'https://evil.example';
const SESSION_COOKIE = `${AUTH_COOKIE_PREFIX}.session_token=the-token.signature`;

/** A real better-auth instance, so the origins are matched as better-auth matches them over HTTP. */
const serviceWith = (advanced: { disableOriginCheck: boolean; disableCSRFCheck?: boolean }) =>
  new AuthService(
    betterAuth({
      telemetry: { enabled: false },
      secret: 'a-test-secret-that-is-long-enough-for-better-auth',
      baseURL: 'http://localhost:3000',
      trustedOrigins: [TRUSTED, 'https://*.preview.example'],
      advanced,
    }) as unknown as ReturnType<typeof authFactory>,
  );

/** better-auth's API stubbed, for the methods that only hand a request on to it. */
const serviceOver = (api: Partial<Record<'getSession' | 'verifyApiKey', jest.Mock>>) =>
  new AuthService({ api } as unknown as ReturnType<typeof authFactory>);

describe('AuthService', () => {
  describe('getSessionFromHeaders', () => {
    it("hands better-auth the request's headers as fetch headers, every value of a repeated one included", async () => {
      const session = { session: { id: 'session-1' }, user: { id: 'user-1' } };
      const getSession = jest.fn().mockResolvedValue(session);

      await expect(
        serviceOver({ getSession }).getSessionFromHeaders({
          cookie: SESSION_COOKIE,
          'x-forwarded-for': ['203.0.113.7', '10.0.0.1'],
          'x-absent': undefined,
        }),
      ).resolves.toBe(session);

      const { headers } = getSession.mock.calls[0][0];
      expect(headers).toBeInstanceOf(Headers);
      expect(headers.get('cookie')).toBe(SESSION_COOKIE);
      expect(headers.get('x-forwarded-for')).toBe('203.0.113.7, 10.0.0.1');
      expect(headers.has('x-absent')).toBe(false);
    });
  });

  describe('isValidSession', () => {
    const service = serviceOver({});
    const sessionExpiring = (expiresAt: Date) => ({ session: { expiresAt }, user: {} }) as unknown as UserSession;

    it('accepts a session that has not expired', () => {
      expect(service.isValidSession(sessionExpiring(new Date(Date.now() + 60_000)))).toBe(true);
    });

    it.each<[string, UserSession | null]>([
      ['no result', null],
      ['a result with no session in it', { user: {} } as unknown as UserSession],
      ['a session that has expired', sessionExpiring(new Date(Date.now() - 60_000))],
    ])('refuses %s', (_, session) => {
      expect(service.isValidSession(session)).toBe(false);
    });
  });

  describe('isTrustedCookieRequest', () => {
    const service = serviceWith({ disableOriginCheck: false });

    it.each<[string, IncomingHttpHeaders]>([
      ['a trusted Origin', { origin: TRUSTED }],
      ['an Origin a trusted pattern matches', { origin: 'https://pr-12.preview.example' }],
      ["the server's own Origin", { origin: 'http://localhost:3000' }],
      // A browser's same-origin GET, socket.io's polling handshake among them, sends no Origin.
      ['a trusted Referer, when no Origin was sent', { referer: `${TRUSTED}/games?page=2` }],
    ])('accepts %s', async (_, headers) => {
      await expect(service.isTrustedCookieRequest(headers)).resolves.toBe(true);
    });

    it.each<[string, IncomingHttpHeaders]>([
      ['an untrusted Origin', { origin: UNTRUSTED }],
      ['a trusted one over the wrong scheme', { origin: 'http://app.example' }],
      ['an untrusted Origin, whatever the Referer says', { origin: UNTRUSTED, referer: `${TRUSTED}/` }],
      ['an untrusted Referer', { referer: `${UNTRUSTED}/` }],
      ['neither an Origin nor a Referer', {}],
      ['an empty Origin', { origin: '' }],
      ['the opaque `null` Origin', { origin: 'null' }],
    ])('refuses %s', async (_, headers) => {
      await expect(service.isTrustedCookieRequest(headers)).resolves.toBe(false);
    });

    it.each([
      ['the origin check', { disableOriginCheck: true }],
      ['the CSRF check', { disableOriginCheck: false, disableCSRFCheck: true }],
    ])('accepts any request, one with no origin included, when %s is disabled', async (_, advanced) => {
      const unchecked = serviceWith(advanced);

      await expect(unchecked.isTrustedCookieRequest({ origin: UNTRUSTED })).resolves.toBe(true);
      await expect(unchecked.isTrustedCookieRequest({})).resolves.toBe(true);
    });
  });

  describe('verifyApiKey', () => {
    it("resolves a valid key to its id and its owner's user id", async () => {
      const verifyApiKey = jest
        .fn()
        .mockResolvedValue({ valid: true, error: null, key: { id: 'key-1', referenceId: 'user-1' } });

      await expect(serviceOver({ verifyApiKey }).verifyApiKey('the-key')).resolves.toEqual({
        id: 'key-1',
        userId: 'user-1',
      });
      expect(verifyApiKey).toHaveBeenCalledWith({ body: { key: 'the-key' } });
    });

    it.each([
      ['a key better-auth refuses', { valid: false, error: { code: 'KEY_NOT_FOUND' }, key: null }],
      ['a valid result that carries no key', { valid: true, error: null, key: null }],
    ])('resolves %s to null', async (_, result) => {
      const verifyApiKey = jest.fn().mockResolvedValue(result);

      await expect(serviceOver({ verifyApiKey }).verifyApiKey('the-key')).resolves.toBeNull();
    });
  });

  describe('hasSessionCredential', () => {
    const service = serviceOver({});

    it.each<[string, IncomingHttpHeaders]>([
      ['a session cookie among others', { cookie: `theme=dark; ${SESSION_COOKIE}` }],
      ['a Bearer Authorization header', { authorization: 'Bearer the-token' }],
    ])('finds %s', (_, headers) => {
      expect(service.hasSessionCredential(headers)).toBe(true);
    });

    it.each<[string, IncomingHttpHeaders]>([
      ['cookies that hold no session cookie', { cookie: 'theme=dark; lb=2' }],
      ['an Authorization header of another scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
      ['a request with neither', {}],
    ])('finds none in %s', (_, headers) => {
      expect(service.hasSessionCredential(headers)).toBe(false);
    });
  });
});
