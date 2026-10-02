import { betterAuth } from 'better-auth';
import type { IncomingHttpHeaders } from 'node:http';
import type { authFactory } from './auth-factory';
import { AuthService } from './auth.service';

const TRUSTED = 'https://app.example';
const UNTRUSTED = 'https://evil.example';

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

describe('AuthService', () => {
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
});
