import { CodedHttpException, t } from '@bge/i18n';
import { Inject, Injectable } from '@nestjs/common';
import { Http } from '@status/codes';
import type { UserSession } from '@thallesp/nestjs-better-auth';
import { APIError } from 'better-auth/api';
import { parseUserOutput } from 'better-auth/db';
import type { UserWithRole } from 'better-auth/plugins';
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

/** What {@link AuthService.createApiKey} creates a key with. */
export interface CreateApiKeyInput {
  /** How long the key lasts, in seconds, as better-auth takes it. */
  readonly expiresInSeconds: number;

  readonly name: string;

  /** The key's owner. */
  readonly userId: string;
}

/**
 * A key {@link AuthService.createApiKey} created. `key` is the secret, which is
 * stored only as a hash: this is the one time it can be read.
 */
export interface CreatedApiKey {
  readonly expiresAt: Date;
  readonly id: string;
  readonly key: string;

  /** The secret's first characters, which better-auth keeps so a user can tell keys apart. */
  readonly start: string | null;
}

/**
 * A user as better-auth returns one with a session: its own fields, plus
 * those its plugins add, such as the admin plugin's `banned` and
 * `banExpires`. The admin plugin's fields are added by hand, because
 * inference over this instance's plugin list leaves them out.
 */
export type AuthUser = ReturnType<typeof authFactory>['$Infer']['Session']['user'] & UserWithRole;

/** The stable code a session read the store could not answer carries, so a client can announce or rephrase it. */
const SESSION_UNAVAILABLE = 'SESSION_UNAVAILABLE';

@Injectable()
export class AuthService {
  constructor(@Inject(AUTH_INSTANCE) private readonly auth: ReturnType<typeof authFactory>) {}

  /**
   * Resolves a session from raw Node request headers (cookies + bearer +
   * anything else BetterAuth knows how to read).
   *
   * When better-auth cannot read the session at all, as when Redis is
   * unreachable, it throws a bare 500. That is answered as a 503 with a
   * plain-language message instead (#640): the caller's session may be fine,
   * so it is neither a server fault nor a reason to sign the caller out. The
   * body carries the stable code `SESSION_UNAVAILABLE` beside the message.
   * Every session read, over HTTP and WebSocket, comes through here.
   *
   * @param headers Inbound request headers
   * @returns Session if resolvable, otherwise `null`
   */
  async getSessionFromHeaders(headers: IncomingHttpHeaders) {
    try {
      return await this.auth.api.getSession({
        headers: this.toFetchHeaders(headers),
      });
    } catch (error) {
      if (error instanceof APIError && error.status === 'INTERNAL_SERVER_ERROR') {
        throw new CodedHttpException(
          Http.ServiceUnavailable,
          SESSION_UNAVAILABLE,
          t('errors.auth.session_unavailable'),
          {
            cause: error,
          },
        );
      }

      throw error;
    }
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
   * Whether a route that sends the browser to `url` afterwards may send it
   * there: an absolute address at one of the trusted origins
   * (`TRUSTED_ORIGINS`, matched as better-auth matches them), as a password
   * reset's link is checked. A relative path is refused.
   *
   * `DISABLE_ORIGIN_CHECK` does not lift it. That setting lets requests in
   * from any origin; sending the browser on to any address it was given would
   * make the route an open redirect (#935).
   */
  async isTrustedReturnAddress(url: string): Promise<boolean> {
    const context = await this.auth.$context;

    return context.isTrustedOrigin(url, { allowRelativePaths: false });
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
   * Creates an API key for `userId` through better-auth's `apiKey` plugin,
   * which generates the secret and stores its hash (#1418).
   *
   * The call is server-side: it passes no headers, so better-auth takes the
   * owner from `body.userId` rather than from a session, and the API key
   * route block, which closes that route to HTTP clients, lets it through.
   * The caller checks who may create the key.
   *
   * Every key is created with an expiry, so a key better-auth stored without
   * one would never expire. That would be a fault in better-auth, not in the
   * request, so it throws instead of answering the key.
   */
  async createApiKey({ userId, name, expiresInSeconds }: CreateApiKeyInput): Promise<CreatedApiKey> {
    const created = await this.auth.api.createApiKey({ body: { userId, name, expiresIn: expiresInSeconds } });

    // Unreachable with the current plugin options: `expiresIn` is always sent
    // and `defaultExpiresIn` is null. If it ever fired, the key row better-auth
    // wrote would stay behind, since the caller gets no id to delete (#1418).
    if (created.expiresAt === null) {
      throw new Error(`better-auth stored API key ${created.id} without an expiry, though one was given (#1418)`);
    }

    return {
      expiresAt: created.expiresAt,
      id: created.id,
      key: created.key,
      start: created.start,
    } satisfies CreatedApiKey;
  }

  /**
   * Reads the user with this id, in the shape a session carries it: fields
   * better-auth never returns are left out. Read fresh on every call, unlike
   * a session's user, which is the row as it stood when the session was
   * created.
   *
   * @returns The user, or `null` when no user has this id
   */
  async findUserById(userId: string): Promise<AuthUser | null> {
    const context = await this.auth.$context;
    const user = await context.internalAdapter.findUserById(userId);

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- better-auth's internal adapter returns its base User, without the fields this instance's plugins add (#1321)
    return user ? (parseUserOutput(context.options, user) as AuthUser) : null;
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
