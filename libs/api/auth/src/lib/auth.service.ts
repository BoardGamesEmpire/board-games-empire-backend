import { Inject, Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import type { IncomingHttpHeaders } from 'node:http';
import type { authFactory } from './auth-factory';
import { AUTH_INSTANCE } from './constants';
import { hasSessionCookie, isBearerAuthorization } from './session-credential';

/**
 * Minimal record returned by {@link AuthService.verifyApiKey} on success.
 * Wraps the BetterAuth response so consumers don't need to navigate the
 * discriminated union themselves.
 */
export interface ResolvedApiKey {
  readonly id: string;
  readonly userId: string;
}

@Injectable()
export class AuthService {
  constructor(@Inject(AUTH_INSTANCE) private readonly auth: ReturnType<typeof authFactory>) {}

  /**
   * Resolves a session from raw Node request headers (cookies + bearer +
   * anything else BetterAuth knows how to read).
   *
   * @param headers Inbound request headers
   * @returns Session if resolvable, otherwise `null`
   */
  getSessionFromHeaders(headers: IncomingHttpHeaders) {
    return this.auth.api.getSession({
      headers: this.toFetchHeaders(headers),
    });
  }

  /**
   * Validates the provided user session by checking its expiration time.
   *
   * @param session
   * @returns boolean indicating whether the session is valid or not
   */
  isValidSession(session: UserSession | null): session is UserSession {
    if (!session?.session) {
      return false;
    }

    return session.session.expiresAt > new Date();
  }

  /**
   * Whether a request with these headers may authenticate with the session
   * cookie, by the rule better-auth applies to its own requests that carry
   * one: the request's `Origin`, or its `Referer` when it sent no `Origin`,
   * must be trusted (`TRUSTED_ORIGINS`, matched as better-auth matches them),
   * and a request with neither, or with the opaque `null` origin, is refused.
   * `DISABLE_ORIGIN_CHECK` lifts the rule, as it does over HTTP.
   *
   * The `Referer` is what a browser's same-origin GET carries in place of an
   * `Origin`, and socket.io's long-polling handshake is one. A page cannot
   * write either header for another site, only leave the `Referer` out.
   *
   * For a transport better-auth never sees, such as a WebSocket handshake.
   * There, nothing else stops a page on another site from opening a
   * connection the browser attaches the cookie to, and reading what it hears.
   */
  async isTrustedCookieRequest(headers: IncomingHttpHeaders): Promise<boolean> {
    const context = await this.auth.$context;
    if (context.skipCSRFCheck || context.skipOriginCheck === true) {
      return true;
    }

    const origin = headers.origin || headers.referer;
    if (!origin || origin === 'null') {
      return false;
    }

    return context.isTrustedOrigin(origin);
  }

  /**
   * Verifies an API key via the BetterAuth `apiKey` plugin. Returns the
   * resolved key (id + owning userId) on success, or `null` for any failure
   * (unknown / revoked / expired / rate-limited).
   *
   * Callers that need to distinguish failure reasons should call
   * `auth.api.verifyApiKey` directly; the boolean-ish shape here is the
   * common case for request-time authentication.
   */
  async verifyApiKey(key: string): Promise<ResolvedApiKey | null> {
    const result = await this.auth.api.verifyApiKey({ body: { key } });

    if (!result.valid || !result.key) {
      return null;
    }

    return {
      id: result.key.id,
      userId: result.key.referenceId,
    } satisfies ResolvedApiKey;
  }

  /**
   * Cheap presence check for a session credential on the inbound request.
   * Recognizes BetterAuth's session cookie and Bearer-token authorization
   * headers ({@link hasSessionCookie}, {@link isBearerAuthorization}).
   *
   * Used by entry-point interceptors to short-circuit the session path and to
   * detect the "API key + session both present" anomaly without paying for a
   * full `getSession` call.
   */
  hasSessionCredential(headers: IncomingHttpHeaders): boolean {
    return hasSessionCookie(headers.cookie) || isBearerAuthorization(headers.authorization);
  }

  private toFetchHeaders(headers: IncomingHttpHeaders): Headers {
    const out = new Headers();
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) {
        for (const entry of value) {
          out.append(name, entry);
        }
      } else if (typeof value === 'string') {
        out.set(name, value);
      }
    }

    return out;
  }
}
