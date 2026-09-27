import { AuditContextService } from '@bge/actor-context';
import type { I18nTranslations } from '@bge/i18n-core';
import type { I18nService, I18nValidationException } from 'nestjs-i18n';
// Not exported from the package root. These are the two functions its own
// pipe and filter use, so importing them keeps a WebSocket frame's messages
// identical to the HTTP body's. The version is pinned exactly, and nodenext
// resolution reads an `exports` map, so a vendor move fails typecheck (#180).
import { formatI18nErrors, mapChildrenToValidationErrors } from 'nestjs-i18n/dist/utils';
import { resolveEdgeLocale } from './translate-exception';

/**
 * The messages an `I18nValidationException` carries, translated against the
 * request locale and flattened into the `string[]` the HTTP body sends.
 *
 * Over HTTP, `I18nValidationPipe` translates the errors itself, inside the
 * request's nestjs-i18n context, and `I18nValidationExceptionFilter` only
 * flattens them. A WebSocket frame has no such context, so the pipe leaves each
 * constraint as its raw `i18nValidationMessage` marker, and the gateway's
 * filter calls this instead. It flattens as `detailedErrors: false` does.
 */
export function translateValidationErrors(
  exception: I18nValidationException,
  i18n: I18nService<I18nTranslations>,
  auditContext: AuditContextService,
): string[] {
  const errors = exception.errorsAlreadyTranslated
    ? exception.errors
    : formatI18nErrors(exception.errors, i18n, { lang: resolveEdgeLocale(auditContext) });

  return errors
    .flatMap((error) => mapChildrenToValidationErrors(error))
    .flatMap((error) => Object.values(error.constraints ?? {}));
}
