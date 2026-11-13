import { AuditContextService } from '@bge/actor-context';
import { t, type I18nTranslations } from '@bge/i18n-core';
import { ArgumentsHost, Catch, HttpException } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Http } from '@status/codes';
import { I18nService } from 'nestjs-i18n';
import { CodedHttpException } from './coded-http.exception';
import { LocaleResolutionService } from './locale-resolution.service';
import { translateException, type EdgeLocaleSource } from './translate-exception';

/** What the filter reads from the request. */
interface EdgeRequest {
  /** Set by Express exactly when a route matched. */
  readonly route?: unknown;
  readonly headers?: { readonly 'accept-language'?: string };
}

/**
 * The single edge component that resolves deferred translations. Services throw
 * standard Nest exceptions carrying a {@link t} key (e.g.
 * `throw new NotFoundException(t('errors.language.not_found', { id }))`); this
 * filter translates the key/args against the request's locale and renders the
 * error envelope (`{ statusCode, error, message, ...fields }`, #1260).
 *
 * Scope is deliberately narrow:
 * - `@Catch(HttpException)` — plain (non-HTTP) errors go on to the
 *   last-resort `UnknownErrorFilter` (#527), which extends this filter and
 *   answers through it. `WsException`s are not `HttpException`s, and —
 *   independently of `@Catch()` — a globally (`APP_FILTER`) registered filter
 *   is never invoked with a WebSocket host at all: Nest's WS exception context
 *   overrides `getGlobalMetadata()` to return `[]` (see `@nestjs/websockets`
 *   `context/exception-filters-context.js`), so globals are excluded from the
 *   WS path. WS localization stays with the gateway-scoped filters (#180). The
 *   `host.getType() !== 'http'` guard below is thus belt-and-suspenders —
 *   reachable only for an `rpc` host, which this app has no inbound transport
 *   for.
 * - Every `HttpException` leaves as the envelope, with or without a `t()`
 *   payload: a body without `error` or `statusCode` (a string body, a coded
 *   refusal's `{ code, message }`) gains them, and a custom `error` label gives
 *   way to the status's reason phrase (#1260).
 * - A 404 for a request no route matched carries `ROUTE_NOT_FOUND` and catalog
 *   copy in place of Nest's `Cannot GET /x` (#634, #527). Nest's own 404 is
 *   otherwise the same shape as a missing row's, so a client could read a moved
 *   or mistyped route as "already removed". The signal is Express's
 *   `req.route`, set exactly when a route matched. A 404 that already carries a
 *   code keeps it: one thrown before routing, by a middleware, lacks a route
 *   too, and its code is the one the client branches on.
 *
 * Locale comes from `AuditContextService.getLocale()` (the CLS value the entry
 * seam resolves before guards run) rather than `I18nContext.current()`, which
 * is unset for guard-thrown errors. An error raised before that seam ran has no
 * CLS locale: body-parser's, whose middleware a global module registers ahead
 * of the app's own. It is rendered in the locale the request's
 * `Accept-Language` resolves to, since its actor isn't known yet (#527).
 * Registered via `APP_FILTER` so Nest wires the `HttpAdapter` and injects the
 * services.
 */
@Catch(HttpException)
export class I18nExceptionFilter extends BaseExceptionFilter {
  constructor(
    private readonly i18n: I18nService<I18nTranslations>,
    private readonly auditContext: AuditContextService,
    private readonly localeResolution: LocaleResolutionService,
  ) {
    super();
  }

  override catch(exception: HttpException, host: ArgumentsHost): void {
    // Non-HTTP host (only an `rpc` host reaches here — a global filter is never
    // invoked with a WS host; see above): default rendering, no translation.
    if (host.getType() !== 'http') {
      this.unhandled(exception, host);
      return;
    }

    this.render(exception, host);
  }

  /**
   * Resolves any deferred `t()` marker against the request locale and sends
   * the body as the error envelope (#1260).
   */
  protected render(exception: HttpException, host: ArgumentsHost): void {
    const request = host.switchToHttp().getRequest<EdgeRequest>();
    super.catch(
      translateException(routeNotFound(exception, request) ?? exception, this.i18n, this.requestLocale(request)),
      host,
    );
  }

  /** Nest's own handling, untranslated: the way out for a host that isn't HTTP. */
  protected unhandled(exception: unknown, host: ArgumentsHost): void {
    super.catch(exception, host);
  }

  /** The CLS locale, or the `Accept-Language` one when CLS holds none (#527). */
  private requestLocale(request: EdgeRequest): EdgeLocaleSource {
    return {
      getLocale: () =>
        clsLocale(this.auditContext) ??
        this.localeResolution.resolveAcceptLanguage(request.headers?.['accept-language']),
    };
  }
}

/** The CLS locale, or `undefined` outside a CLS scope or before one is stored. */
function clsLocale(auditContext: AuditContextService): string | undefined {
  try {
    return auditContext.getLocale() ?? undefined;
  } catch {
    return undefined;
  }
}

/** The coded 404 for a request no route matched, or `undefined` for any other exception (#634). */
function routeNotFound(exception: HttpException, request: EdgeRequest): CodedHttpException | undefined {
  if (exception.getStatus() !== Http.NotFound || request.route !== undefined || hasCode(exception.getResponse())) {
    return undefined;
  }

  return new CodedHttpException(Http.NotFound, 'ROUTE_NOT_FOUND', t('errors.request.route_not_found'), {
    cause: exception,
  });
}

function hasCode(body: unknown): boolean {
  return body !== null && typeof body === 'object' && 'code' in body;
}
