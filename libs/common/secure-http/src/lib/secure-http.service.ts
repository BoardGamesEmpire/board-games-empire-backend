import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { request as undiciRequest } from 'undici';
import type Dispatcher from 'undici/types/dispatcher';
import {
  InvalidRequestUrlError,
  OutboundNetworkError,
  RedirectLimitExceededError,
  RedirectToDisallowedTargetError,
  RequestTimeoutError,
  ResponseTooLargeError,
  SafeHttpError,
  SsrfRejectionError,
} from './errors';
import { HttpDispatcherFactory } from './http-dispatcher.factory';
import type {
  OutboundErrorEvent,
  OutboundHttpObserver,
  OutboundRequestEvent,
  OutboundResponseEvent,
  RedirectDeniedEvent,
  SafeHttpDownloadOptions,
  SafeHttpDownloadResult,
  SafeHttpMethod,
  SafeHttpPolicySnapshot,
  SafeHttpRequestBody,
  SafeHttpRequestOptions,
  SafeHttpResponse,
  SafeHttpResponseType,
  SafeHttpRetryPolicy,
  SsrfRejectionEvent,
} from './interfaces';
import { IpFamily } from './ip';
import { IpPolicyService } from './ip/ip-policy.service';
import { SafeHttpPolicyService } from './policy/safe-http-policy.service';
import { OUTBOUND_HTTP_OBSERVER } from './safe-http.tokens';

/**
 * Hard ceiling on response body size, regardless of caller options. 10 MiB
 * is generous for webhook payloads and plugin RPCs; any caller that needs
 * larger should be using a dedicated streaming endpoint, not this service.
 *
 * Defends against malicious targets returning unbounded responses to exhaust
 * server memory.
 */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Status codes that trigger retry when a retry policy is configured. */
const DEFAULT_RETRY_STATUSES: readonly number[] = [408, 429, 502, 503, 504];

/** Default cap on backoff between retry attempts. */
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/**
 * Resolved per-request settings after merging caller options with the
 * current policy snapshot. Internal — never exposed past the request method.
 */
interface ResolvedOptions {
  method: SafeHttpMethod;
  headers: Record<string, string>;
  body?: SafeHttpRequestBody;
  timeoutMs: number;
  maxRedirects: number;
  responseType: SafeHttpResponseType;
  retry?: SafeHttpRetryPolicy;
  signal?: AbortSignal;
  /**
   * One time limit shared by every hop. `download()` sets it; `request()`
   * leaves it out, so each hop gets its own `timeoutMs`.
   */
  deadline?: AbortSignal;
}

/** Where a terminal 2xx body goes instead of memory. */
interface DownloadSink {
  destination: string;
  maxBytes: number;
}

/** A file-system failure on the destination, tagged so `download()` can pass it through unwrapped. */
class DestinationError extends Error {
  constructor(readonly original: unknown) {
    super('Download destination failed');
  }
}

/** The terminal answer of a redirect chain, before it is shaped for a caller. */
interface TerminalHop {
  hop: HopResult;
  finalUrl: string;
  redirectCount: number;
  durationMs: number;
}

interface HopResult {
  status: number;
  headers: Record<string, string>;
  bodyBytes: Buffer;
  /** Set when the body was streamed to a `DownloadSink`. */
  written?: { bytes: number; sha256: string };
}

/**
 * Outbound HTTP service with SSRF defense. Every request goes through the
 * full evaluation pipeline:
 *
 *   1. URL parse + scheme check.
 *   2. SSRF gauntlet via `IpPolicyService` (resolves DNS, validates IP
 *      against permanent and admin block/allow lists).
 *   3. HTTP request via undici with the resolved IP pinned at the Agent
 *      connect layer — eliminates the TOCTOU window between DNS resolution
 *      and TCP connect.
 *   4. Manual redirect handling: 3xx responses re-run the full gauntlet on
 *      `Location` before issuing the next hop. No "first hop validated,
 *      subsequent hops trusted" shortcuts.
 *   5. Body parsing per `responseType` (json/text/arraybuffer).
 *
 * Retries (when configured) re-run the gauntlet on every attempt, so a
 * policy change mid-retry takes effect on the next attempt.
 *
 * Observer hooks fire at request start, response, error, SSRF rejection,
 * and redirect denial. Observer exceptions are caught and logged; they
 * never propagate to the caller.
 *
 * Thrown errors from this service are always subclasses of `SafeHttpError`.
 * HTTP non-success statuses are NOT thrown — they're returned on
 * `SafeHttpResponse.status` so the caller can branch on application
 * semantics.
 */
@Injectable()
export class SecureHttpService {
  private readonly logger = new Logger(SecureHttpService.name);

  constructor(
    private readonly policy: SafeHttpPolicyService,
    private readonly ipPolicy: IpPolicyService,
    private readonly dispatcherFactory: HttpDispatcherFactory,
    @Inject(OUTBOUND_HTTP_OBSERVER) private readonly observer: OutboundHttpObserver,
  ) {}

  async request<T = unknown>(url: string, options: SafeHttpRequestOptions = {}): Promise<SafeHttpResponse<T>> {
    // Clamp to a safe positive integer. `attempts: 0`, negative, NaN, or
    // Infinity from a misconfigured caller would otherwise skip the loop and
    // surface as a misleading "Retry loop exhausted" error. Treat anything
    // outside [1, ∞) as "single attempt, no retry".
    const rawAttempts = options.retry?.attempts ?? 1;
    const totalAttempts = Number.isFinite(rawAttempts) && rawAttempts >= 1 ? Math.floor(rawAttempts) : 1;

    const startedAt = Date.now();
    let lastError: SafeHttpError | undefined;

    for (let attempt = 1; attempt <= totalAttempts; attempt++) {
      const snapshot = this.policy.current();
      const resolved = this.resolveOptions(options, snapshot);

      await this.notify('onRequest', { url, method: resolved.method, attempt });

      try {
        const response = await this.executeWithRedirects<T>(url, resolved, snapshot);

        await this.notify('onResponse', {
          url,
          method: resolved.method,
          status: response.status,
          durationMs: response.durationMs,
          redirectCount: response.redirectCount,
        });

        // Retry on configured status codes — final-status response triggers
        // retry only when a policy is set and we haven't exhausted attempts.
        if (resolved.retry && attempt < totalAttempts && this.shouldRetryStatus(response.status, resolved.retry)) {
          await this.sleep(this.computeBackoff(attempt, resolved.retry));
          continue;
        }

        return response;
      } catch (err) {
        const safeErr = this.toSafeHttpError(url, err);
        lastError = safeErr;

        await this.notify('onError', {
          url,
          method: resolved.method,
          error: safeErr,
          durationMs: Date.now() - startedAt,
        });

        // SSRF and URL errors are policy failures, not transient — never retry.
        // Redirect-limit also doesn't retry (the loop is the bug, not the network).
        // An oversized body won't shrink on a second try (#1094).
        if (
          safeErr instanceof SsrfRejectionError ||
          safeErr instanceof InvalidRequestUrlError ||
          safeErr instanceof RedirectToDisallowedTargetError ||
          safeErr instanceof RedirectLimitExceededError ||
          safeErr instanceof ResponseTooLargeError
        ) {
          throw safeErr;
        }

        if (resolved.retry && attempt < totalAttempts && this.shouldRetryError(safeErr, resolved.retry)) {
          await this.sleep(this.computeBackoff(attempt, resolved.retry));
          continue;
        }

        throw safeErr;
      }
    }

    // Unreachable in practice — the loop either returns or throws on the
    // final attempt. Defensive check for type narrowing.
    throw lastError ?? new OutboundNetworkError(url, new Error('Retry loop exhausted with no error'));
  }

  /**
   * Stream a response body to a file under a byte cap and one time limit.
   *
   * Runs the same per-hop gauntlet as `request()`. Only a 2xx terminal answer
   * is written; any other status returns `written: null` and creates no file.
   * `timeoutMs` is one limit counted from the call: it cuts off every hop's
   * connection, its answer and the body, but not the outbound HTTP policy's
   * address lookup before a hop, which the resolver's own timeouts bound. The
   * file is created with `wx` and removed on any failure after it exists. No
   * retry.
   *
   * Throws only `SafeHttpError` subclasses, plus file-system errors on the
   * destination itself (such as `EEXIST`), which propagate as they are (#1094).
   */
  async download(url: string, options: SafeHttpDownloadOptions): Promise<SafeHttpDownloadResult> {
    const snapshot = this.policy.current();
    const deadline = AbortSignal.timeout(options.timeoutMs);
    const resolved: ResolvedOptions = {
      method: 'GET',
      headers: options.headers ?? {},
      timeoutMs: options.timeoutMs,
      maxRedirects: options.maxRedirects ?? snapshot.defaultMaxRedirects,
      responseType: 'arraybuffer',
      signal: options.signal,
      deadline,
    };
    const sink: DownloadSink = { destination: options.destination, maxBytes: options.maxBytes };
    const startedAt = Date.now();

    await this.notify('onRequest', { url, method: 'GET', attempt: 1 });

    try {
      const terminal = await this.followRedirects(url, resolved, snapshot, sink);
      const result: SafeHttpDownloadResult = {
        status: terminal.hop.status,
        headers: Object.freeze({ ...terminal.hop.headers }),
        finalUrl: terminal.finalUrl,
        redirectCount: terminal.redirectCount,
        durationMs: terminal.durationMs,
        written: terminal.hop.written ?? null,
      };

      await this.notify('onResponse', {
        url,
        method: 'GET',
        status: result.status,
        durationMs: result.durationMs,
        redirectCount: result.redirectCount,
      });

      return result;
    } catch (err) {
      // A destination failure (EEXIST, ENOSPC...) reaches the caller as the
      // raw file-system error, but the observer still gets a terminal event.
      // The event carries a SafeHttpError, so it sees the same wrapped form
      // as any other unclassified failure (#1094).
      const original = err instanceof DestinationError ? err.original : err;
      const safeErr = this.toSafeHttpError(url, original);
      await this.notify('onError', { url, method: 'GET', error: safeErr, durationMs: Date.now() - startedAt });
      throw err instanceof DestinationError ? original : safeErr;
    }
  }

  // ───────────────────────────────────────────────────────────────
  // Redirect loop with per-hop SSRF
  // ───────────────────────────────────────────────────────────────

  private async executeWithRedirects<T>(
    initialUrl: string,
    options: ResolvedOptions,
    snapshot: SafeHttpPolicySnapshot,
  ): Promise<SafeHttpResponse<T>> {
    const { hop, finalUrl, redirectCount, durationMs } = await this.followRedirects(initialUrl, options, snapshot);
    return this.buildResponse<T>(hop, finalUrl, redirectCount, durationMs, options.responseType);
  }

  private async followRedirects(
    initialUrl: string,
    options: ResolvedOptions,
    snapshot: SafeHttpPolicySnapshot,
    sink?: DownloadSink,
  ): Promise<TerminalHop> {
    const startedAt = Date.now();
    let currentUrl = initialUrl;
    let currentMethod = options.method;
    let currentBody = options.body;
    let redirectCount = 0;

    while (true) {
      const parsedUrl = this.parseUrl(currentUrl);

      // ── SSRF gauntlet for this hop ─────────────────────────────
      const decision = await this.ipPolicy.evaluate(parsedUrl, snapshot);
      if (!decision.allowed) {
        const ssrfErr = new SsrfRejectionError(decision.hostname, decision.reason, decision.ip);

        if (redirectCount === 0) {
          await this.notify('onSsrfRejection', {
            host: decision.hostname,
            ip: decision.ip,
            reason: decision.reason,
          });

          throw ssrfErr;
        }

        // Redirect hop rejection — wrap with the from/to context.
        await this.notify('onRedirectDenied', {
          from: initialUrl,
          to: currentUrl,
          reason: decision.reason,
        });
        throw new RedirectToDisallowedTargetError(initialUrl, currentUrl, ssrfErr);
      }

      // ── Execute single hop with pinned IP ──────────────────────
      const hop = await this.executeHop(
        parsedUrl,
        decision.hostname,
        decision.pinnedIp,
        decision.pinnedFamily,
        currentMethod,
        options.headers,
        currentBody,
        options.timeoutMs,
        options.signal,
        options.deadline,
        sink,
      );

      // ── Redirect handling ──────────────────────────────────────
      if (this.isFollowableRedirect(hop.status) && hop.headers['location']) {
        if (redirectCount >= options.maxRedirects) {
          throw new RedirectLimitExceededError(initialUrl, options.maxRedirects);
        }

        const nextUrl = this.resolveRedirectTarget(hop.headers['location'], currentUrl);

        // Method + body rewriting per Fetch spec:
        //   - 303 always becomes GET, body dropped.
        //   - 301/302 with non-GET/HEAD becomes GET, body dropped (legacy
        //     compatibility — Fetch spec mandates this for browsers).
        //   - 307/308 preserves method and body.
        if (
          hop.status === 303 ||
          ((hop.status === 301 || hop.status === 302) && currentMethod !== 'GET' && currentMethod !== 'HEAD')
        ) {
          currentMethod = 'GET';
          currentBody = undefined;
        }

        currentUrl = nextUrl;
        redirectCount++;

        continue;
      }

      // ── Terminal response ──────────────────────────────────────
      return { hop, finalUrl: currentUrl, redirectCount, durationMs: Date.now() - startedAt };
    }
  }

  // ───────────────────────────────────────────────────────────────
  // Single-hop execution with pinned IP
  // ───────────────────────────────────────────────────────────────

  private async executeHop(
    url: URL,
    hostname: string,
    pinnedIp: string,
    pinnedFamily: IpFamily,
    method: SafeHttpMethod,
    callerHeaders: Record<string, string>,
    body: SafeHttpRequestBody | undefined,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
    deadline: AbortSignal | undefined,
    sink: DownloadSink | undefined,
  ): Promise<HopResult> {
    const { headers, payload } = this.marshalRequest(callerHeaders, body, hostname);

    const timeoutSignal = deadline ?? AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([timeoutSignal, callerSignal]) : timeoutSignal;

    const agent = this.dispatcherFactory.build(pinnedIp, pinnedFamily, timeoutMs);
    try {
      // Manual redirect handling happens in the outer loop with a fresh
      // SSRF gauntlet per hop. undici's `request()` does NOT auto-follow
      // redirects by default (auto-follow requires opting into the
      // RedirectHandler interceptor at the Agent level, which our pinned
      // Agent does not configure) — so 3xx responses are returned as-is.
      const result = await undiciRequest(url, {
        method,
        headers,
        body: payload,
        dispatcher: agent,
        signal,
      });

      const status = result.statusCode;
      const responseHeaders = this.normalizeHeaders(result.headers);

      // Only the terminal answer goes to the sink. A redirect's body is
      // never read for a download: nothing uses it, and reading it under
      // request()'s 10 MiB ceiling would refuse a small artifact behind a
      // large redirect page as too large, at a limit the caller never set.
      const redirecting = this.isFollowableRedirect(status) && !!responseHeaders['location'];
      if (sink) {
        if (redirecting || status < 200 || status > 299) {
          result.body.destroy();
          return { status, headers: responseHeaders, bodyBytes: Buffer.alloc(0) };
        }

        const written = await this.streamToFile(result.body, responseHeaders, url, sink);
        return { status, headers: responseHeaders, bodyBytes: Buffer.alloc(0), written };
      }

      const bodyBytes = await this.readBodyCapped(result.body, url);
      return { status, headers: responseHeaders, bodyBytes };
    } catch (err) {
      // Distinguish timeout from generic network failure for clean error mapping.
      // A destination or cap failure is already specific, so it wins over a
      // timeout that fires while the stream is being torn down.
      if (timeoutSignal.aborted && !(err instanceof DestinationError) && !(err instanceof ResponseTooLargeError)) {
        throw new RequestTimeoutError(url.toString(), timeoutMs);
      }

      throw err;
    } finally {
      // Close the per-hop agent so the underlying socket is released
      // promptly. Agent pooling across hops would leak IP pinning across
      // requests with different decisions.
      await agent.close().catch(() => undefined);
    }
  }

  // ───────────────────────────────────────────────────────────────
  // Body marshalling
  // ───────────────────────────────────────────────────────────────

  private marshalRequest(
    callerHeaders: Record<string, string>,
    body: SafeHttpRequestBody | undefined,
    hostname: string,
  ): { headers: Record<string, string>; payload: string | Buffer | undefined } {
    // Lower-case all header keys for consistent overrides and matching.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(callerHeaders)) {
      headers[k.toLowerCase()] = v;
    }

    // Force Host header to the original hostname — undici typically sets
    // this itself, but being explicit avoids surprises when pinning.
    headers['host'] = hostname;

    if (body === undefined || body === null) {
      return { headers, payload: undefined };
    }

    if (typeof body === 'string') {
      return { headers, payload: body };
    }

    if (body instanceof Uint8Array) {
      return { headers, payload: Buffer.from(body.buffer, body.byteOffset, body.byteLength) };
    }

    if (body instanceof ArrayBuffer) {
      return { headers, payload: Buffer.from(body) };
    }

    // Object or array — JSON encode and set Content-Type if absent.
    if (!('content-type' in headers)) {
      headers['content-type'] = 'application/json';
    }
    return { headers, payload: JSON.stringify(body) };
  }

  private buildResponse<T>(
    hop: HopResult,
    finalUrl: string,
    redirectCount: number,
    durationMs: number,
    responseType: SafeHttpResponseType,
  ): SafeHttpResponse<T> {
    const rawString = responseType === 'arraybuffer' ? null : hop.bodyBytes.toString('utf-8');
    const rawArrayBuffer = responseType === 'arraybuffer' ? this.toArrayBuffer(hop.bodyBytes) : null;

    let body: T | null;
    let raw: string | ArrayBuffer;

    switch (responseType) {
      case 'json': {
        raw = rawString ?? '';
        if (rawString === null || rawString.length === 0) {
          body = null;
        } else {
          try {
            body = JSON.parse(rawString) as T;
          } catch {
            body = null;
          }
        }
        break;
      }

      case 'text': {
        raw = rawString ?? '';
        body = (rawString ?? '') as unknown as T;
        break;
      }

      case 'arraybuffer': {
        raw = rawArrayBuffer ?? new ArrayBuffer(0);
        body = (rawArrayBuffer ?? new ArrayBuffer(0)) as unknown as T;
        break;
      }
    }

    return {
      status: hop.status,
      headers: Object.freeze({ ...hop.headers }),
      body,
      raw,
      durationMs,
      finalUrl,
      redirectCount,
    };
  }

  // ───────────────────────────────────────────────────────────────
  // Helpers
  // ───────────────────────────────────────────────────────────────

  private resolveOptions(options: SafeHttpRequestOptions, snapshot: SafeHttpPolicySnapshot): ResolvedOptions {
    return {
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
      body: options.body,
      timeoutMs: options.timeoutMs ?? snapshot.defaultTimeoutMs,
      maxRedirects: options.maxRedirects ?? snapshot.defaultMaxRedirects,
      responseType: options.responseType ?? 'json',
      retry: options.retry,
      signal: options.signal,
    };
  }

  private parseUrl(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      throw new InvalidRequestUrlError(url, 'parse-failure', err instanceof Error ? err.message : undefined);
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new InvalidRequestUrlError(url, 'invalid-scheme', `unsupported scheme: ${parsed.protocol}`);
    }

    return parsed;
  }

  private resolveRedirectTarget(location: string, base: string): string {
    try {
      return new URL(location, base).toString();
    } catch {
      throw new InvalidRequestUrlError(location, 'parse-failure', 'Location header could not be parsed');
    }
  }

  private isFollowableRedirect(status: number): boolean {
    return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
  }

  /**
   * Pipe a body to `sink.destination` through a counting, hashing transform.
   * The file is opened exclusively before any byte is read, so an existing
   * path fails with `EEXIST` and is never removed. Once opened, any failure
   * removes the file before the error propagates.
   */
  private async streamToFile(
    body: Dispatcher.ResponseData['body'],
    headers: Record<string, string>,
    url: URL,
    sink: DownloadSink,
  ): Promise<{ bytes: number; sha256: string }> {
    const declared = Number(headers['content-length']);
    if (Number.isFinite(declared) && declared > sink.maxBytes) {
      body.destroy();
      throw new ResponseTooLargeError(url.toString(), sink.maxBytes);
    }

    let handle;
    try {
      handle = await open(sink.destination, 'wx');
    } catch (err) {
      body.destroy();
      throw new DestinationError(err);
    }

    const hash = createHash('sha256');
    let bytes = 0;
    const counter = new Transform({
      transform: (chunk: Buffer, _encoding, callback: TransformCallback) => {
        bytes += chunk.length;
        if (bytes > sink.maxBytes) {
          callback(new ResponseTooLargeError(url.toString(), sink.maxBytes));
          return;
        }

        hash.update(chunk);
        callback(null, chunk);
      },
    });

    const file = handle.createWriteStream();
    // The first stream to fail is the cause: pipeline then destroys the rest
    // with that same error, so a file stream that merely received a source or
    // cap error must not be mistaken for a destination failure (#1094).
    let firstFailure: { stream: unknown; error: unknown } | undefined;
    for (const stream of [body, counter, file]) {
      stream.once('error', (error) => {
        firstFailure ??= { stream, error };
      });
    }

    try {
      await pipeline(body, counter, file);
    } catch (err) {
      await handle.close().catch(() => undefined);
      await rm(sink.destination, { force: true }).catch(() => undefined);
      throw firstFailure?.stream === file ? new DestinationError(firstFailure.error) : err;
    }

    return { bytes, sha256: hash.digest('hex') };
  }

  private async readBodyCapped(body: Dispatcher.ResponseData['body'], url: URL): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of body) {
      const buf = chunk instanceof Buffer ? chunk : Buffer.from(chunk);
      total += buf.length;

      if (total > MAX_RESPONSE_BYTES) {
        // Destroy the stream to release the connection promptly.
        body.destroy?.();
        throw new ResponseTooLargeError(url.toString(), MAX_RESPONSE_BYTES);
      }

      chunks.push(buf);
    }

    return Buffer.concat(chunks, total);
  }

  private normalizeHeaders(input: Dispatcher.ResponseData['headers']): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) {
        continue;
      }

      const lower = key.toLowerCase();
      if (Array.isArray(value)) {
        out[lower] = value.join(', ');
      } else {
        out[lower] = String(value);
      }
    }

    return out;
  }

  /**
   * Copy a Node `Buffer` into a freshly-allocated `ArrayBuffer`. `Buffer`s
   * are backed by `ArrayBufferLike` which TypeScript narrows to
   * `ArrayBuffer | SharedArrayBuffer`; we want a strict `ArrayBuffer` on
   * the public surface. Constructing one and copying eliminates the union
   * without a cast. The allocation is bounded by `MAX_RESPONSE_BYTES`
   * (10 MiB), so the duplicate is acceptable cost.
   */
  private toArrayBuffer(buf: Buffer): ArrayBuffer {
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(buf);
    return ab;
  }

  private toSafeHttpError(url: string, err: unknown): SafeHttpError {
    if (err instanceof SafeHttpError) {
      return err;
    }

    if (err instanceof Error) {
      return new OutboundNetworkError(url, err);
    }

    return new OutboundNetworkError(url, new Error(String(err)));
  }

  private shouldRetryStatus(status: number, retry: SafeHttpRetryPolicy): boolean {
    const statuses = retry.retryOnStatusCodes ?? DEFAULT_RETRY_STATUSES;
    return statuses.includes(status);
  }

  private shouldRetryError(err: SafeHttpError, retry: SafeHttpRetryPolicy): boolean {
    if (retry.retryOnNetworkError === false) {
      return false;
    }
    return err instanceof OutboundNetworkError || err instanceof RequestTimeoutError;
  }

  private computeBackoff(attempt: number, retry: SafeHttpRetryPolicy): number {
    const cap = retry.maxDelayMs ?? DEFAULT_MAX_BACKOFF_MS;
    const exp = Math.min(retry.baseDelayMs * 2 ** (attempt - 1), cap);
    if (retry.jitter === false) return exp;
    return Math.floor(Math.random() * exp);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ───────────────────────────────────────────────────────────────
  // Observer notifications — failures isolated from the caller
  // ───────────────────────────────────────────────────────────────

  private async notify(method: 'onRequest', event: OutboundRequestEvent): Promise<void>;
  private async notify(method: 'onResponse', event: OutboundResponseEvent): Promise<void>;
  private async notify(method: 'onError', event: OutboundErrorEvent): Promise<void>;
  private async notify(method: 'onSsrfRejection', event: SsrfRejectionEvent): Promise<void>;
  private async notify(method: 'onRedirectDenied', event: RedirectDeniedEvent): Promise<void>;
  private async notify(method: keyof OutboundHttpObserver, event: unknown): Promise<void> {
    const handler = this.observer[method] as ((e: unknown) => void | Promise<void>) | undefined;
    if (!handler) return;
    try {
      await handler.call(this.observer, event);
    } catch (err) {
      this.logger.warn(`Observer.${method} threw and was suppressed: ${err instanceof Error ? err.message : err}`);
    }
  }
}
