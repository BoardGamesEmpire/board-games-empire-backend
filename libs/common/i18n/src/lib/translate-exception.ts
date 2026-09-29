import { AuditContextService } from '@bge/actor-context';
import { isI18nMessage, type I18nMessage, type I18nTranslations } from '@bge/i18n-core';
import { HttpException, Logger } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { STATUS_CODES } from 'node:http';
import { FALLBACK_LOCALE } from './locale.constants';

const logger = new Logger('translateException');

/**
 * Resolves the request locale from CLS for edge translation, degrading to
 * {@link FALLBACK_LOCALE} when no CLS scope is active (a wiring bug, not a normal
 * request) rather than failing the response — matching the entry-seam contract.
 */
export function resolveEdgeLocale(auditContext: AuditContextService): string {
  try {
    return auditContext.getLocale() ?? FALLBACK_LOCALE;
  } catch {
    return FALLBACK_LOCALE;
  }
}

/**
 * The single place the error path consults `I18nService`. Resolves a deferred
 * {@link t} marker carried by `exception`, in one of two shapes:
 *
 * 1. **Whole-body marker** (the common case) — the response body *is* the marker
 *    (`throw new NotFoundException(t('errors.…', { … }))`). Returns a fresh
 *    standard `HttpException` whose body is that marker translated against the
 *    request locale (`{ statusCode, message, error }` — Nest's default shape).
 * 2. **Structured body with a marker `message`** — the body is an object that
 *    carries machine-readable fields (e.g. `QuotaExceededException`'s
 *    `resource`/`scope`/`limit`) *beside* a translatable `message` marker.
 *    Translates just the `message` field in place, preserving every other field
 *    and the custom `error` label.
 *
 * In both cases the original status and `cause` are preserved, and a catalog
 * entry that cannot render is sent as its key rather than thrown. Any other
 * exception is returned untouched (referentially, so callers can `super.catch`
 * it byte-for-byte as before).
 *
 * Shared by every edge component that renders exceptions itself: the global
 * {@link I18nExceptionFilter}; the media `StorageExceptionFilter` /
 * `MulterExceptionFilter` and the plugin `PluginExceptionFilter`, which are
 * controller-scoped and therefore run *instead of* the global filter (Nest picks
 * the most specific matching filter), so they must resolve markers themselves
 * rather than delegate; and the WebSocket gateways' `WsErrorFilter`, since no
 * global filter runs on a gateway message (#180).
 */
export function translateException(
  exception: HttpException,
  i18n: I18nService<I18nTranslations>,
  auditContext: AuditContextService,
): HttpException {
  const body = exception.getResponse();
  const status = exception.getStatus();

  // (1) Whole body is a marker → replace it with Nest's default error shape.
  if (isI18nMessage(body)) {
    const message = render(body, i18n, auditContext);
    // Carry the original `cause` across the re-issue so server-side context is not
    // stripped (e.g. StorageExceptionFilter attaches the raw storage error as
    // `cause` for logs). `{ cause: undefined }` is a no-op in Nest's `initCause`,
    // so markers thrown without a cause still render byte-identically.
    return new HttpException({ statusCode: status, message, error: STATUS_CODES[status] ?? exception.name }, status, {
      cause: exception.cause,
    });
  }

  // (2) Structured body whose `message` field is a marker → translate that field
  // in place, keeping every sibling field (resource/scope/limit/…, the custom
  // `error` label) and the status/cause intact.
  if (body !== null && typeof body === 'object') {
    const marker = (body as { message?: unknown }).message;
    if (isI18nMessage(marker)) {
      const message = render(marker, i18n, auditContext);
      return new HttpException({ ...body, message }, status, { cause: exception.cause });
    }
  }

  return exception;
}

/**
 * A marker in the request locale, or its key when the catalog entry cannot
 * render (a template string-format rejects). That failure is logged, and the
 * key keeps the exception's status and every other body field. A throw would
 * escape the filter that called this: over HTTP the client would get Express's
 * own 500, and a WS frame no answer at all. The args stay off the wire, since
 * some carry request input. `WsTranslator` answers the same failure the same
 * way.
 */
function render(marker: I18nMessage, i18n: I18nService<I18nTranslations>, auditContext: AuditContextService): string {
  const lang = resolveEdgeLocale(auditContext);
  try {
    return i18n.translate(marker.key, { lang, args: marker.args });
  } catch (error) {
    logger.error(`Could not render '${marker.key}' in '${lang}'`, error instanceof Error ? error.stack : error);
    return marker.key;
  }
}
