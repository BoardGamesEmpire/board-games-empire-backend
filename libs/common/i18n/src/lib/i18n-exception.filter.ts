import { AuditContextService } from '@bge/actor-context';
import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { I18nService } from 'nestjs-i18n';
import { STATUS_CODES } from 'node:http';
import type { I18nTranslations } from './generated/i18n.generated';
import { FALLBACK_LOCALE } from './locale.constants';
import { isI18nMessage } from './translatable';

/**
 * The single edge component that resolves deferred translations. Services throw
 * standard Nest exceptions carrying a {@link t} key (e.g.
 * `throw new NotFoundException(t('errors.language.not_found', { id }))`); this
 * filter translates the key/args against the request's locale and renders the
 * normal Nest error body (`{ statusCode, message, error }`).
 *
 * Scope is deliberately narrow:
 * - `@Catch(HttpException)` — plain (non-HTTP) errors keep Nest's default 500
 *   handling; `WsException`s are not `HttpException`s and stay with the
 *   gateway-scoped filters (WS localization is #180).
 * - Any `HttpException` WITHOUT a `t()` payload is passed straight to
 *   `super.catch`, so every existing exception renders byte-identically to
 *   before this filter existed.
 *
 * Locale comes from `AuditContextService.getLocale()` (the CLS value the entry
 * seam resolves before guards run) rather than `I18nContext.current()`, which
 * is unset for guard-thrown errors. Registered via `APP_FILTER` so Nest wires
 * the `HttpAdapter` and injects `I18nService` / `AuditContextService`.
 */
@Catch(HttpException)
export class I18nExceptionFilter extends BaseExceptionFilter {
  constructor(
    private readonly i18n: I18nService<I18nTranslations>,
    private readonly auditContext: AuditContextService,
  ) {
    super();
  }

  override catch(exception: HttpException, host: ArgumentsHost): void {
    const body = host.getType() === 'http' ? exception.getResponse() : null;

    if (!isI18nMessage(body)) {
      // Non-i18n exception (or non-HTTP transport): default Nest rendering.
      super.catch(exception, host);
      return;
    }

    let lang: string = FALLBACK_LOCALE;
    try {
      lang = this.auditContext.getLocale() ?? FALLBACK_LOCALE;
    } catch {
      // No active CLS scope (a wiring bug, not a normal request): degrade to
      // the fallback locale rather than failing the error response.
    }

    const status = exception.getStatus();
    const message = this.i18n.translate(body.key, { lang, args: body.args });

    // Re-issue as a standard HttpException so BaseExceptionFilter renders the
    // usual `{ statusCode, message, error }` shape (and honors the status).
    super.catch(
      new HttpException({ statusCode: status, message, error: STATUS_CODES[status] ?? exception.name }, status),
      host,
    );
  }
}
