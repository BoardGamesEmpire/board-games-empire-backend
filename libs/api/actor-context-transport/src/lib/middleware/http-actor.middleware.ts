import type { Actor } from '@bge/actor-context';
import { AuditContextInternalService } from '@bge/actor-context';
import { AuthService } from '@bge/auth';
import { CORRELATION_ID_HEADER, TRACEPARENT_HEADER } from '@bge/shared';
import { firstValue, resolveCorrelationId, sessionImpersonatorId } from '@bge/utils';
import { ForbiddenException, Injectable, Logger, UnauthorizedException, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import type { AnonymousUserSession } from '../interfaces';

export const API_KEY_HEADER = 'x-api-key' as const;

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
 *     - Success → `{ kind: 'apiKey', apiKeyId, userId }`.
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
      const actor = await this.resolveActor(req);

      this.auditContext.populate({
        actor,
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

  private async resolveActor(req: Request): Promise<Actor | null> {
    const apiKey = firstValue(req.headers[API_KEY_HEADER]);
    if (apiKey) {
      if (this.authService.hasSessionCredential(req.headers)) {
        this.logger.warn(`Request carries both '${API_KEY_HEADER}' and a session credential; preferring API key`);
      }
      return this.actorFromApiKey(apiKey);
    }

    return this.actorFromSession(req);
  }

  private async actorFromApiKey(key: string): Promise<Actor> {
    const resolved = await this.authService.verifyApiKey(key);

    if (!resolved) {
      throw new UnauthorizedException('Invalid API key');
    }

    return {
      kind: 'apiKey',
      apiKeyId: resolved.id,
      userId: resolved.userId,
    };
  }

  private async actorFromSession(req: Request): Promise<Actor | null> {
    if (!this.authService.hasSessionCredential(req.headers)) {
      return null;
    }

    const session = await this.authService.getSessionFromHeaders(req.headers);

    if (!session) {
      return null;
    }

    const user = session.user as AnonymousUserSession;

    const impersonatorId = sessionImpersonatorId(session);
    if (impersonatorId) {
      // The ids and the issue reference go to the log, not to the caller: the
      // response must disclose neither which admin is behind the session nor
      // an internal tracker number. A raw literal rather than a `t()` key is
      // deliberate — this middleware runs BEFORE LocaleResolutionMiddleware
      // (see AppModule.configure), so no request locale exists yet; the
      // sibling `UnauthorizedException` above is a literal for the same reason.
      this.logger.warn(`Refusing impersonated session (#408): target=${user?.id} impersonatedBy=${impersonatorId}`);
      throw new ForbiddenException('Impersonated sessions are not supported');
    }

    this.logger.debug(`Resolved session for user ${user.id} (anonymous: ${user.isAnonymous})`);
    if (user.isAnonymous) {
      return { kind: 'anonymous', userId: user.id };
    }

    return { kind: 'user', userId: user.id };
  }
}
