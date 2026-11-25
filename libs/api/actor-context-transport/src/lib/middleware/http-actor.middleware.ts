import type { Actor } from '@bge/actor-context';
import { AuditContextInternalService } from '@bge/actor-context';
import type { AuthUser } from '@bge/auth';
import { AuthService } from '@bge/auth';
import { t } from '@bge/i18n';
import { CORRELATION_ID_HEADER, TRACEPARENT_HEADER } from '@bge/shared';
import { firstValue, resolveCorrelationId, sessionImpersonatorId } from '@bge/utils';
import type { NestMiddleware } from '@nestjs/common';
import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { AnonymousUserSession } from '../interfaces';

export const API_KEY_HEADER = 'x-api-key' as const;

interface ResolvedActor {
  readonly actor: Actor | null;

  /** The session's `createdAt`, for a signed-in user only (#1418). */
  readonly sessionSignedInAt?: Date;
}

/**
 * Populates CLS actor + correlation context for HTTP requests.
 *
 * Implemented as **middleware** rather than an interceptor so it runs BEFORE
 * guards. Permission guards (CASL) read the actor from CLS — if this ran as
 * an interceptor (post-guard), guards would see a null actor and authorize
 * incorrectly.
 *
 * Resolution rules:
 *  1. If `x-api-key` is present → delegate to `AuthService.verifyApiKey`.
 *     - Success → `{ kind: 'apiKey', apiKeyId, userId }`, once the key's
 *       owner is read and found able to use it. See below.
 *     - Failure → forwards `UnauthorizedException` to the next error handler.
 *  2. Otherwise → delegate to `AuthService.getSessionFromHeaders`.
 *     - Impersonated   → refuse the request (`ForbiddenException`). See below.
 *     - Anonymous user → `{ kind: 'anonymous', userId }`.
 *     - Regular user  → `{ kind: 'user', userId }`.
 *     - No session    → actor populated as `null` (downstream guards reject).
 *  3. If BOTH credentials are present → prefer the API key per the locked
 *     decision; log a warning so the anomaly is visible.
 *
 * Impersonation (#408): a session carrying `impersonatedBy` would otherwise
 * mint `{ kind: 'user', userId: <target> }`, and every `AuditLog` row written
 * under it would name the impersonated user with no trace of the admin behind
 * it. Impersonation is blocked at the admin plugin's role map, so no such
 * session can currently be created; this guard is what makes that block
 * reviewable rather than silent — whoever unblocks impersonation has to decide
 * how it is audited before requests will serve.
 *
 * Note that this guard does NOT cover `/api/auth/*`. better-auth is mounted on
 * the raw Express instance in `main.ts` before Nest binds its middleware in
 * `app.listen()`, so its handler runs first and terminates the response. That
 * is deliberate (better-auth needs the unparsed body), and it is why the role
 * map — not this guard — is what denies the impersonation endpoint. It also
 * leaves `/admin/stop-impersonating` reachable, so an already-impersonated
 * session can still unwind itself.
 *
 * A key's owner (#529): better-auth checks a ban only when it creates a
 * session or a key, so a key minted before its owner was banned would keep
 * working with the owner's roles. The owner's row is therefore read on every
 * key request: an owner under a ban that has not expired gets a 403, and an
 * expired ban lets the key work again. A key whose owner no longer exists is
 * refused as invalid, since deleting a user leaves their keys behind (see the
 * TODO in `authFactory`).
 *
 * Nothing sets `request.session` or `request.user`, which better-auth's
 * guard used to and its `@Session()` decorator reads. A handler that needs
 * the caller reads the actor (`getActingUserId()`), which names the user
 * behind a key as well as a session's; one written against `@Session()`
 * fails its first test instead of failing only for keys.
 *
 * Correlation: `traceparent` → `x-correlation-id` → generated UUID.
 *
 * Requires `ClsMiddleware` (from `nestjs-cls`) to have run first so this
 * middleware has an active CLS scope to populate.
 */
@Injectable()
export class HttpActorMiddleware implements NestMiddleware {
  private readonly logger = new Logger(HttpActorMiddleware.name);

  constructor(
    private readonly auditContext: AuditContextInternalService,
    private readonly authService: AuthService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      const { actor, sessionSignedInAt } = await this.resolveActor(req);

      this.auditContext.populate({
        actor,
        ...(sessionSignedInAt && { sessionSignedInAt }),
        correlationId: resolveCorrelationId({
          traceparent: req.headers[TRACEPARENT_HEADER],
          correlationId: req.headers[CORRELATION_ID_HEADER],
        }),
        source: 'http',
      });

      next();
    } catch (error) {
      // Forward to the Express / Nest error pipeline rather than throwing
      // synchronously from async middleware.
      next(error);
    }
  }

  private async resolveActor(req: Request): Promise<ResolvedActor> {
    const apiKey = firstValue(req.headers[API_KEY_HEADER]);
    if (apiKey) {
      if (this.authService.hasSessionCredential(req.headers)) {
        this.logger.warn(`Request carries both '${API_KEY_HEADER}' and a session credential; preferring API key`);
      }

      return { actor: await this.actorFromApiKey(apiKey) };
    }

    return this.actorFromSession(req);
  }

  private async actorFromApiKey(key: string): Promise<Actor> {
    const resolved = await this.authService.verifyApiKey(key);

    if (!resolved) {
      throw new UnauthorizedException(t('errors.api_key.invalid'));
    }

    const owner = await this.authService.findUserById(resolved.userId);

    if (!owner) {
      this.logger.warn(`Refusing API key ${resolved.id}: its owner ${resolved.userId} no longer exists`);
      throw new UnauthorizedException(t('errors.api_key.invalid'));
    }

    if (isBanInForce(owner)) {
      this.logger.warn(`Refusing API key ${resolved.id}: its owner ${resolved.userId} is banned`);
      throw new ForbiddenException(t('errors.api_key.owner_banned'));
    }

    return {
      kind: 'apiKey',
      apiKeyId: resolved.id,
      userId: resolved.userId,
    };
  }

  private async actorFromSession(req: Request): Promise<ResolvedActor> {
    if (!this.authService.hasSessionCredential(req.headers)) {
      return { actor: null };
    }

    const session = await this.authService.getSessionFromHeaders(req.headers);

    if (!session) {
      return { actor: null };
    }

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- better-auth's inference over this instance's plugin list leaves out the anonymous plugin's isAnonymous (#1321)
    const user = session.user as AnonymousUserSession;

    const impersonatorId = sessionImpersonatorId(session);
    if (impersonatorId) {
      // The ids and the issue reference go to the log, not to the caller: the
      // response must disclose neither which admin is behind the session nor
      // an internal tracker number, so the marker carries no args. This
      // middleware runs BEFORE LocaleResolutionMiddleware (see
      // AppModule.configure), so no request locale exists yet: this refusal and
      // the API-key ones above render in the locale the request's
      // Accept-Language resolves to, which the global filter reads (#508).
      this.logger.warn(`Refusing impersonated session (#408): target=${user?.id} impersonatedBy=${impersonatorId}`);
      throw new ForbiddenException(t('errors.auth.impersonated_session'));
    }

    this.logger.debug(`Resolved session for user ${user.id} (anonymous: ${user.isAnonymous})`);
    if (user.isAnonymous) {
      return { actor: { kind: 'anonymous', userId: user.id } };
    }

    // Only a signed-in user carries a sign-in time: an anonymous session has
    // no sign-in to be recent, and an API key never read a session (#1418).
    const signedInAt = new Date(session.session.createdAt);

    return {
      actor: { kind: 'user', userId: user.id },
      ...(!Number.isNaN(signedInAt.getTime()) && { sessionSignedInAt: signedInAt }),
    };
  }
}

/**
 * Whether the user is under a ban, by the rule better-auth applies when one
 * signs in: banned with no expiry, or with an expiry still to come.
 */
function isBanInForce(user: AuthUser): boolean {
  if (!user.banned) {
    return false;
  }

  return !user.banExpires || new Date(user.banExpires).getTime() > Date.now();
}
