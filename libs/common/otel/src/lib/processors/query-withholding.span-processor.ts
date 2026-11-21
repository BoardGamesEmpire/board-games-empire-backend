import { normalizeRequestPath } from '@bge/logger';
import type { Span, SpanProcessor } from '@opentelemetry/sdk-trace';

/**
 * The attributes a request's address is recorded under, query string
 * included: the HTTP instrumentation's server span writes `http.url` and
 * `http.target` under the older conventions, the NestJS instrumentation's
 * handler span writes `http.url` or `url.full` as the request's original URL.
 */
const ADDRESS_ATTRIBUTES = ['http.url', 'http.target', 'url.full'] as const;

/** The query string alone, as the HTTP instrumentation writes it under the current conventions. */
const QUERY_ATTRIBUTE = 'url.query';

/** Where a span's request path is read from, the attribute that holds it alone first. */
const PATH_ATTRIBUTES = ['url.path', ...ADDRESS_ATTRIBUTES] as const;

/** `address` up to its query string. */
const withoutQuery = (address: string): string => address.split('?', 1)[0] ?? address;

/**
 * The request path a span records, from an absolute address or a path, or
 * undefined for a span that records no request.
 */
function requestPath(span: Span): string | undefined {
  for (const key of PATH_ATTRIBUTES) {
    const value = span.attributes[key];
    if (typeof value !== 'string') {
      continue;
    }

    const address = withoutQuery(value);

    return URL.canParse(address) ? new URL(address).pathname : address;
  }

  return undefined;
}

/**
 * OpenTelemetry {@link SpanProcessor} that keeps a request's query string out
 * of the spans for the paths it is told to withhold it for, as the api's
 * request log does (#935). The Steam sign-in's return carries the SteamID in
 * its query, and unlinking deletes the SteamID, so it must not stay in a
 * trace backend either.
 *
 * The instrumentations record the address as the span starts, so `onStart`
 * rewrites each address attribute to its path and removes `url.query`. The
 * span is the SDK's own, still open, and nothing reads its attributes before
 * the export processors see the span end. It runs first, ahead of every
 * other processor.
 *
 * The paths are added after the SDK starts, through
 * {@link withholdQueryFor}: the list names routes from feature libs, and
 * importing those before the SDK starts would leave the modules they load
 * uninstrumented. No request is served before the app adds them.
 */
export class QueryWithholdingSpanProcessor implements SpanProcessor {
  private readonly paths = new Set<string>();

  /**
   * Withholds the query of a request to any of `paths`, global prefix
   * included (`/api/...`), from every span that starts from now on.
   */
  withholdQueryFor(paths: readonly string[]): void {
    for (const path of paths) {
      this.paths.add(normalizeRequestPath(path));
    }
  }

  onStart(span: Span): void {
    if (this.paths.size === 0) {
      return;
    }

    const path = requestPath(span);
    if (path === undefined || !this.paths.has(normalizeRequestPath(path))) {
      return;
    }

    for (const key of ADDRESS_ATTRIBUTES) {
      const value = span.attributes[key];
      if (typeof value === 'string') {
        span.setAttribute(key, withoutQuery(value));
      }
    }

    // The Span API sets attributes but has no way to remove one.
    Reflect.deleteProperty(span.attributes, QUERY_ATTRIBUTE);
  }

  onEnd(): void {
    // No-op: the query is gone from the span once it starts.
  }

  async shutdown(): Promise<void> {
    // No buffered state to flush.
  }

  async forceFlush(): Promise<void> {
    // No buffered state to flush.
  }
}
