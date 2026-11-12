import { AuditContextService } from '@bge/actor-context';
import type { I18nTranslations } from '@bge/i18n-core';
import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { I18nService } from 'nestjs-i18n';
import { translateException } from './translate-exception';

/**
 * The single edge component that resolves deferred translations. Services throw
 * standard Nest exceptions carrying a {@link t} key (e.g.
 * `throw new NotFoundException(t('errors.language.not_found', { id }))`); this
 * filter translates the key/args against the request's locale and renders the
 * error envelope (`{ statusCode, error, message, ...fields }`, #1260).
 *
 * Scope is deliberately narrow:
 * - `@Catch(HttpException)` — plain (non-HTTP) errors keep Nest's default 500
 *   handling. `WsException`s are not `HttpException`s, and — independently of
 *   `@Catch()` — a globally (`APP_FILTER`) registered filter is never invoked
 *   with a WebSocket host at all: Nest's WS exception context overrides
 *   `getGlobalMetadata()` to return `[]` (see `@nestjs/websockets`
 *   `context/exception-filters-context.js`), so globals are excluded from the
 *   WS path. WS localization stays with the gateway-scoped filters (#180). The
 *   `host.getType() !== 'http'` guard below is thus belt-and-suspenders —
 *   reachable only for an `rpc` host, which this app has no inbound transport
 *   for.
 * - Every `HttpException` leaves as the envelope, with or without a `t()`
 *   payload: a body without `error` or `statusCode` (a string body, a coded
 *   refusal's `{ code, message }`) gains them, and a custom `error` label gives
 *   way to the status's reason phrase (#1260).
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
    // Non-HTTP host (only an `rpc` host reaches here — a global filter is never
    // invoked with a WS host; see above): default rendering, no translation.
    if (host.getType() !== 'http') {
      super.catch(exception, host);
      return;
    }

    // Resolve any deferred `t()` marker against the request locale and re-issue
    // the body as the error envelope (#1260).
    super.catch(translateException(exception, this.i18n, this.auditContext), host);
  }
}
