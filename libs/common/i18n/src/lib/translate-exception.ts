import { AuditContextService } from '@bge/actor-context';
import { HttpException } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { STATUS_CODES } from 'node:http';
import type { I18nTranslations } from './generated/i18n.generated';
import { FALLBACK_LOCALE } from './locale.constants';
import { isI18nMessage } from './translatable';

/**
 * Resolves the request locale from CLS for edge translation, degrading to
 * {@link FALLBACK_LOCALE} when no CLS scope is active (a wiring bug, not a normal
 * request) rather than failing the response — matching the entry-seam contract.
 */
function resolveEdgeLocale(auditContext: AuditContextService): string {
  try {
    return auditContext.getLocale() ?? FALLBACK_LOCALE;
  } catch {
    return FALLBACK_LOCALE;
  }
}

/**
 * The single place the error path consults `I18nService`. If `exception` carries
 * a deferred {@link t} marker as its response body, returns a fresh standard
 * `HttpException` whose body is that marker translated against the request locale
 * (`{ statusCode, message, error }` — Nest's default shape, original status
 * preserved); otherwise returns `exception` untouched (referentially, so callers
 * can `super.catch` it byte-for-byte as before).
 *
 * Shared by every edge component that renders exceptions itself: the global
 * {@link I18nExceptionFilter}, and the media `StorageExceptionFilter` /
 * `MulterExceptionFilter`, which are controller-scoped and therefore run
 * *instead of* the global filter (Nest picks the most specific matching filter),
 * so they must resolve markers themselves rather than delegate.
 */
export function translateException(
  exception: HttpException,
  i18n: I18nService<I18nTranslations>,
  auditContext: AuditContextService,
): HttpException {
  const body = exception.getResponse();
  if (!isI18nMessage(body)) {
    return exception;
  }

  const status = exception.getStatus();
  const message = i18n.translate(body.key, { lang: resolveEdgeLocale(auditContext), args: body.args });
  return new HttpException({ statusCode: status, message, error: STATUS_CODES[status] ?? exception.name }, status);
}
