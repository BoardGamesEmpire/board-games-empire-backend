import { AuditContextService } from '@bge/actor-context';
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import type { I18nTranslations } from './generated/i18n.generated';
import { FALLBACK_LOCALE } from './locale.constants';
import { isI18nMessage } from './translatable';

/**
 * Success-path counterpart to {@link I18nExceptionFilter}. Controllers embed a
 * deferred {@link t} marker in their response body for user-facing success copy
 * (e.g. `map((game) => ({ game, message: t('success.game.created') }))`); this
 * interceptor resolves every marker against the request locale before Nest
 * serializes the body, so services/controllers stay decoupled from
 * `I18nService` exactly as the exception path does.
 *
 * Only the HTTP path is transformed. Locale comes from
 * `AuditContextService.getLocale()` (the CLS value resolved before guards run),
 * matching the filter; if no CLS scope is active it degrades to
 * {@link FALLBACK_LOCALE}. Marker-free bodies are returned by reference — the
 * walk allocates nothing unless it actually rewrites a marker.
 *
 * Registered as the outermost interceptor, outside the response cache: the
 * cache stores locale-independent markers, and on a cache hit this interceptor
 * still resolves the marker even though Valkey rehydrates it as a prototype-less
 * object — {@link isI18nMessage} matches its serializable brand, not `instanceof`.
 */
@Injectable()
export class I18nResponseInterceptor implements NestInterceptor {
  // Bounds the recursion for pathological/cyclic bodies. Response DTOs nest far
  // shallower than this; a marker below it simply renders untranslated rather
  // than risking an unbounded walk.
  private static readonly MAX_DEPTH = 8;

  constructor(
    private readonly i18n: I18nService<I18nTranslations>,
    private readonly auditContext: AuditContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    return next.handle().pipe(map((body) => this.resolve(body, this.locale(), 0)));
  }

  private locale(): string {
    try {
      return this.auditContext.getLocale() ?? FALLBACK_LOCALE;
    } catch {
      // No active CLS scope (a wiring bug, not a normal request): degrade to the
      // fallback locale rather than failing the response.
      return FALLBACK_LOCALE;
    }
  }

  /**
   * Recursively replaces {@link I18nMessage} markers with their translated
   * string. Descends only plain objects/arrays (never `Date`s, class instances,
   * etc.). A container is cloned **lazily** — only once one of its own children
   * actually changes — and unchanged subtrees are returned by reference, so a
   * marker-free body (the common case, incl. large list responses) walks through
   * allocating nothing.
   */
  private resolve(value: unknown, lang: string, depth: number): unknown {
    if (isI18nMessage(value)) {
      return this.i18n.translate(value.key, { lang, args: value.args });
    }

    if (depth >= I18nResponseInterceptor.MAX_DEPTH) {
      return value;
    }

    if (Array.isArray(value)) {
      let clone: unknown[] | undefined;
      for (let i = 0; i < value.length; i++) {
        const resolved = this.resolve(value[i], lang, depth + 1);
        if (resolved !== value[i]) {
          (clone ??= value.slice())[i] = resolved;
        }
      }
      return clone ?? value;
    }

    if (isPlainObject(value)) {
      let clone: Record<string, unknown> | undefined;
      for (const key in value) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          continue;
        }
        const resolved = this.resolve(value[key], lang, depth + 1);
        if (resolved !== value[key]) {
          (clone ??= { ...value })[key] = resolved;
        }
      }
      return clone ?? value;
    }

    return value;
  }
}

/** Plain data object only — excludes `Date`, class instances, and `null`. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
