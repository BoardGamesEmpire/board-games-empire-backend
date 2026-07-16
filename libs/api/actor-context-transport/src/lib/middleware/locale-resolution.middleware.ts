import { actorUserId, AuditContextInternalService, AuditContextService } from '@bge/actor-context';
import { FALLBACK_LOCALE, LocaleResolutionService } from '@bge/i18n';
import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * Resolves the request's catalog locale and stores it in the CLS
 * actor-context envelope, where `ClsLocaleResolver` (nestjs-i18n) and any
 * other consumer read it via `AuditContextService.getLocale()`.
 *
 * Implemented as **middleware** rather than a nestjs-i18n resolver so the
 * locale exists BEFORE guards run — guard-thrown errors (AuthGuard,
 * ThrottlerGuard) can be translated (#142/#143), while nestjs-i18n's own
 * resolution happens in a post-guard interceptor.
 *
 * Must run after `ClsMiddleware` (active CLS scope) and `HttpActorMiddleware`
 * (the actor's stored preference is the top of the precedence chain).
 *
 * Resolution failures never break the request: the locale degrades to
 * `FALLBACK_LOCALE` and the error is logged.
 */
@Injectable()
export class LocaleResolutionMiddleware implements NestMiddleware {
  private readonly logger = new Logger(LocaleResolutionMiddleware.name);

  constructor(
    private readonly auditContext: AuditContextService,
    private readonly auditContextInternal: AuditContextInternalService,
    private readonly localeResolution: LocaleResolutionService,
  ) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    try {
      let locale: string = FALLBACK_LOCALE;

      try {
        const actor = this.auditContext.getActor();
        locale = await this.localeResolution.resolve({
          userId: actor ? actorUserId(actor) : null,
          acceptLanguage: req.headers['accept-language'],
        });
      } catch (error) {
        this.logger.warn(
          `Locale resolution failed; continuing with '${FALLBACK_LOCALE}'`,
          error instanceof Error ? error.stack : undefined,
        );
      }

      this.auditContextInternal.setLocale(locale);
      next();
    } catch (error) {
      // Only wiring bugs land here (e.g. no active CLS scope). Forward to the
      // Express / Nest error pipeline rather than throwing from async
      // middleware.
      next(error);
    }
  }
}
