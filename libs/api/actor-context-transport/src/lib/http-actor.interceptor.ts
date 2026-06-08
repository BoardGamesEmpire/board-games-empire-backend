import type { Actor } from '@bge/actor-context';
import { AuditContextInternalService } from '@bge/actor-context/internal';
import { AuthService } from '@bge/auth';
import { CORRELATION_ID_HEADER, TRACEPARENT_HEADER } from '@bge/shared';
import { firstValue, resolveCorrelationId } from '@bge/utils';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { Request } from 'express';
import { from, type Observable } from 'rxjs';
import { mergeMap } from 'rxjs/operators';
import { ActorInterceptor } from './actor.interceptor';
import type { AnonymousUserSession } from './interfaces';

export const API_KEY_HEADER = 'x-api-key' as const;

/**
 * Populates CLS actor + correlation context for HTTP requests.
 *
 * Rules:
 *  1. If `x-api-key` is present → delegate to AuthService.verifyApiKey.
 *     - Success → `{ kind: 'apiKey', apiKeyId, userId }`.
 *     - Failure → throws `UnauthorizedException` (explicit auth attempt).
 *  2. Otherwise → delegate to AuthService.getSessionFromHeaders.
 *     - Anonymous user → `{ kind: 'anonymous', userId }`.
 *     - Regular user  → `{ kind: 'user', userId }`.
 *     - No session    → actor remains `null`.
 *  3. If BOTH `x-api-key` and a session credential are present → prefer the
 *     API key per the locked decision; log a warning so the anomaly is
 *     visible.
 *
 * Correlation: `traceparent` → `x-correlation-id` → generated UUID.
 *
 * Source is always `'http'`.
 *
 * Requires an outer `ClsInterceptor` (or `ClsMiddleware`) to have opened a
 * CLS scope. Register globally after the CLS interceptor.
 */
@Injectable()
export class HttpActorInterceptor extends ActorInterceptor {
  protected readonly executionContextType = 'http';

  constructor(
    auditContext: AuditContextInternalService,
    private readonly authService: AuthService,
  ) {
    super(auditContext);
  }

  intercept(executionContext: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = executionContext.switchToHttp().getRequest<Request>();

    return from(this.resolveActor(request)).pipe(
      mergeMap((actor) => {
        this.auditContext.populate({
          actor,
          correlationId: resolveCorrelationId({
            traceparent: request.headers[TRACEPARENT_HEADER],
            correlationId: request.headers[CORRELATION_ID_HEADER],
          }),
          source: this.source,
        });

        return next.handle();
      }),
    );
  }

  private async resolveActor(request: Request): Promise<Actor | null> {
    const apiKey = firstValue(request.headers[API_KEY_HEADER]);

    if (apiKey) {
      if (this.authService.hasSessionCredential(request.headers)) {
        this.logger.warn(`Request carries both '${API_KEY_HEADER}' and a session credential; preferring API key`);
      }
      return this.actorFromApiKey(apiKey);
    }

    return this.actorFromSession(request);
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

  private async actorFromSession(request: Request): Promise<Actor | null> {
    // Skip the (network/DB-backed) session lookup for requests that carry no
    // session credential at all — the common case for public/unauthenticated
    // traffic on the hot path.
    if (!this.authService.hasSessionCredential(request.headers)) {
      return null;
    }

    const session = await this.authService.getSessionFromHeaders(request.headers);

    if (!session) {
      return null;
    }

    const user = session.user as AnonymousUserSession;
    if (user.isAnonymous) {
      return { kind: 'anonymous', userId: user.id };
    }

    return { kind: 'user', userId: user.id };
  }
}
