import { Inject, Injectable } from '@nestjs/common';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import type { IncomingHttpHeaders } from 'node:http';
import type { authFactory } from './auth-factory';
import { AUTH_INSTANCE } from './constants';

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
   * Retrieves the user session associated with the provided token.
   *
   * @param token The authentication token.
   * @returns The user session or null
   */
  getSessionFromToken(token: string) {
    return this.auth.api.getSession({
      headers: new Headers({
        Authorization: `Bearer ${token}`,
      }),
    });
  }

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
   * headers.
   *
   * BetterAuth names the cookie `<prefix>.session_token` (or
   * `<prefix>-session_token`), prepending `__Secure-` when secure cookies are
   * enabled. The prefix is `bge_auth_` per `auth-factory`, so the live cookie
   * is e.g. `bge_auth_.session_token` / `__Secure-bge_auth_.session_token`.
   *
   * Used by entry-point interceptors to short-circuit the session path and to
   * detect the "API key + session both present" anomaly without paying for a
   * full `getSession` call.
   */
  hasSessionCredential(headers: IncomingHttpHeaders): boolean {
    const cookie = headers.cookie;
    if (typeof cookie === 'string' && /(?:^|;\s*)(?:__Secure-)?bge_auth_[.-]session_token=/.test(cookie)) {
      return true;
    }

    const authorization = headers.authorization;
    if (typeof authorization === 'string' && /^Bearer\s+/i.test(authorization)) {
      return true;
    }

    return false;
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
