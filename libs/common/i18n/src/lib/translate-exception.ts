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
 * In both cases the original status and `cause` are preserved. Any other
 * exception is returned untouched (referentially, so callers can `super.catch`
 * it byte-for-byte as before).
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
  const status = exception.getStatus();

  // (1) Whole body is a marker → replace it with Nest's default error shape.
  if (isI18nMessage(body)) {
    const message = i18n.translate(body.key, { lang: resolveEdgeLocale(auditContext), args: body.args });
    // Carry the original `cause` across the re-issue so server-side context is not
    // stripped (e.g. StorageExceptionFilter attaches the raw storage error as
    // `cause` for logs). `{ cause: undefined }` is a no-op in Nest's `initCause`,
    // so markers thrown without a cause still render byte-identically.
    return new HttpException(
      { statusCode: status, message, error: STATUS_CODES[status] ?? exception.name },
      status,
      { cause: exception.cause },
    );
  }

  // (2) Structured body whose `message` field is a marker → translate that field
  // in place, keeping every sibling field (resource/scope/limit/…, the custom
  // `error` label) and the status/cause intact.
  if (body !== null && typeof body === 'object') {
    const marker = (body as { message?: unknown }).message;
    if (isI18nMessage(marker)) {
      const message = i18n.translate(marker.key, { lang: resolveEdgeLocale(auditContext), args: marker.args });
      return new HttpException({ ...body, message }, status, { cause: exception.cause });
    }
  }

  return exception;
}
