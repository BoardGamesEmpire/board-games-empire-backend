import { LOCALE_CLS_KEY } from '@bge/actor-context';
import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import type { I18nResolver } from 'nestjs-i18n';

/**
 * The single nestjs-i18n resolver: reads the locale that the entry seam
 * already resolved into the CLS actor-context envelope
 * (`LocaleResolutionMiddleware` on HTTP; #146/#147 for queue/gRPC/WS).
 *
 * All precedence logic lives in `LocaleResolutionService` — deliberately NOT
 * in nestjs-i18n resolvers, which run in a post-guard interceptor: too late
 * for guard-thrown errors, and CLS would still be needed for non-HTTP paths.
 *
 * Reads the raw CLS key via `ClsService` because nestjs-i18n instantiates
 * resolver classes inside its own global module context, where only global
 * providers are injectable — `AuditContextService` is not. Read-only; the
 * lib-local eslint config carves out exactly this key.
 *
 * Returns undefined when no seam has populated a locale (e.g. WS before
 * #147), deferring to `fallbackLanguage`.
 */
@Injectable()
export class ClsLocaleResolver implements I18nResolver {
  constructor(private readonly cls: ClsService) {}

  // Implements I18nResolver.resolve; the ExecutionContext param is omitted —
  // the locale comes from CLS, not the transport context.
  resolve(): string | undefined {
    if (!this.cls.isActive()) {
      return undefined;
    }

    return this.cls.get<string | undefined>(LOCALE_CLS_KEY);
  }
}
