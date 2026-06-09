import type { Actor } from '@bge/actor-context';
import { AuditContextInternalService } from '@bge/actor-context';
import { AuthService } from '@bge/auth';
import { CORRELATION_ID_HEADER, TRACEPARENT_HEADER } from '@bge/shared';
import { resolveCorrelationId } from '@bge/utils';
import { Injectable, Logger, UnauthorizedException, type NestMiddleware } from '@nestjs/common';
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
 *     - Anonymous user → `{ kind: 'anonymous', userId }`.
 *     - Regular user  → `{ kind: 'user', userId }`.
 *     - No session    → actor populated as `null` (downstream guards reject).
 *  3. If BOTH credentials are present → prefer the API key per the locked
 *     decision; log a warning so the anomaly is visible.
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
    const apiKey = this.firstHeader(req.headers[API_KEY_HEADER]);

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
    const session = await this.authService.getSessionFromHeaders(req.headers);

    if (!session) {
      return null;
    }

    const user = session.user as AnonymousUserSession;
    this.logger.debug(`Resolved session for user ${user.id} (anonymous: ${user.isAnonymous})`);
    if (user.isAnonymous) {
      return { kind: 'anonymous', userId: user.id };
    }

    return { kind: 'user', userId: user.id };
  }

  private firstHeader(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }
}
