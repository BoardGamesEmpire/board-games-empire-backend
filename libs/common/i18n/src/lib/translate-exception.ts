import type { AuditContextService } from '@bge/actor-context';
import { isI18nMessage, type I18nMessage, type I18nTranslations } from '@bge/i18n-core';
import { HttpException, Logger } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { errorEnvelope, reasonPhrase, type ErrorEnvelope } from './error-envelope';
import { FALLBACK_LOCALE } from './locale.constants';

const logger = new Logger('translateException');

/**
 * Where an edge component reads the request locale: `AuditContextService`
 * itself, or a filter's own source that falls back on the request's
 * `Accept-Language` when CLS holds no locale yet (#527).
 */
export type EdgeLocaleSource = Pick<AuditContextService, 'getLocale'>;

/**
 * Resolves the request locale from CLS for edge translation, degrading to
 * {@link FALLBACK_LOCALE} when no CLS scope is active (a wiring bug, not a normal
 * request) rather than failing the response — matching the entry-seam contract.
 */
export function resolveEdgeLocale(locale: EdgeLocaleSource): string {
  try {
    return locale.getLocale() ?? FALLBACK_LOCALE;
  } catch {
    return FALLBACK_LOCALE;
  }
}

/**
 * The single place the error path consults `I18nService`. Every exception
 * leaves as the error envelope (#1260), `{ statusCode, error, message,
 * ...fields }`, whatever body it was thrown with:
 *
 * - a whole-body marker (`throw new NotFoundException(t('errors.…', { … }))`)
 *   becomes the message, rendered in the request locale;
 * - a structured body (a coded refusal's `code`, a quota's `limit`) keeps every
 *   field, and its `message` marker is rendered in place;
 * - a plain string body (`new BadRequestException('…')` from a library) is the
 *   message as it was.
 *
 * `error` is always the status's reason phrase, so a custom label never reaches
 * a client. The original status and `cause` are preserved, and a catalog entry
 * that cannot render is sent as its key rather than thrown. See
 * {@link renderErrorBody} for how each body is read.
 *
 * Shared by every edge component that renders exceptions itself: the global
 * {@link I18nExceptionFilter}; the media `StorageExceptionFilter` /
 * `MulterExceptionFilter` and the plugin `PluginExceptionFilter`, which are
 * controller-scoped and therefore run *instead of* the global filter (Nest picks
 * the most specific matching filter), so they must resolve markers themselves
 * rather than delegate. The WebSocket gateways' `WsErrorFilter`, which no
 * global filter backs either (#180), sends the envelope as a frame rather than
 * an exception, so it calls {@link renderErrorBody} directly.
 */
export function translateException(
  exception: HttpException,
  i18n: I18nService<I18nTranslations>,
  locale: EdgeLocaleSource,
): HttpException {
  const status = exception.getStatus();
  // Carry the original `cause` across the re-issue so server-side context is not
  // stripped (e.g. StorageExceptionFilter attaches the raw storage error as
  // `cause` for logs). `{ cause: undefined }` is a no-op in Nest's `initCause`.
  return new HttpException(renderErrorBody(status, exception.getResponse(), i18n, locale), status, {
    cause: exception.cause,
  });
}

/**
 * Reads any `HttpException` body into the error envelope (#1260, #325):
 *
 * - a string body is the message;
 * - a marker body is rendered in the request locale;
 * - an object body's `message` is rendered if it is a marker and kept if it is a
 *   string; a list (a validation 400) is read item by item the same way. No
 *   message at all gives the status's reason phrase, and so does one that is
 *   none of these, which is logged. Every other key, apart from the
 *   envelope's own, becomes a field.
 *
 * For {@link translateException}, and for an edge component that answers with
 * the envelope itself rather than through an exception (the WebSocket filter).
 */
export function renderErrorBody(
  status: number,
  body: unknown,
  i18n: I18nService<I18nTranslations>,
  locale: EdgeLocaleSource,
): ErrorEnvelope {
  if (typeof body === 'string') {
    return errorEnvelope(status, body);
  }

  if (isI18nMessage(body)) {
    return errorEnvelope(status, renderMarker(body, i18n, locale));
  }

  if (body !== null && typeof body === 'object') {
    const { message, ...fields } = body as Record<string, unknown>;
    return errorEnvelope(status, renderMessage(status, message, i18n, locale), fields);
  }

  return errorEnvelope(status, reasonPhrase(status));
}

function renderMessage(
  status: number,
  message: unknown,
  i18n: I18nService<I18nTranslations>,
  locale: EdgeLocaleSource,
): string | string[] {
  if (isLine(message)) {
    return renderLine(message, i18n, locale);
  }

  if (Array.isArray(message) && message.every(isLine)) {
    return message.map((line) => renderLine(line, i18n, locale));
  }

  // A message no client can read (a number, a nested object) is dropped
  // rather than sent, and said so, so the lost detail is never silent.
  if (message !== undefined) {
    logger.warn(`A ${status} body carried a message no client can read; sent its reason phrase`);
  }

  return reasonPhrase(status);
}

/** One line of a message: copy as it is, or a marker to render. */
function isLine(value: unknown): value is string | I18nMessage {
  return typeof value === 'string' || isI18nMessage(value);
}

function renderLine(line: string | I18nMessage, i18n: I18nService<I18nTranslations>, locale: EdgeLocaleSource): string {
  return typeof line === 'string' ? line : renderMarker(line, i18n, locale);
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
export function renderMarker(
  marker: I18nMessage,
  i18n: I18nService<I18nTranslations>,
  locale: EdgeLocaleSource,
): string {
  const lang = resolveEdgeLocale(locale);
  try {
    return i18n.translate(marker.key, { lang, args: marker.args });
  } catch (error) {
    logger.error(`Could not render '${marker.key}' in '${lang}'`, error instanceof Error ? error.stack : error);
    return marker.key;
  }
}
