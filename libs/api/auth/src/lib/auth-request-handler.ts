import type { I18nPath } from '@bge/i18n';
import { Logger } from '@nestjs/common';
import { withStorageFailureRecord, type StorageFailureRecord } from './storage-failure-record';

/** better-auth's fetch handler: a request in, a response out. */
export type AuthRequestHandler = (request: Request) => Promise<Response>;

export interface AuthRequestHandlerDeps {
  /** Renders a refusal's catalog key. */
  readonly render: (key: I18nPath) => string;
}

/** The stable code a rate-limited request carries, so a client can announce or rephrase it. */
const RATE_LIMITED = 'RATE_LIMITED';

/** The stable code a request carries when the storage failed while answering it. */
const AUTH_UNAVAILABLE = 'AUTH_UNAVAILABLE';

/** The stable code a request carries when something other than the storage failed while answering it (#894). */
const AUTH_FAILED = 'AUTH_FAILED';

/**
 * The requests whose body was cut off at the limit (#1057). The node handler
 * marks one as the bytes pass the limit, before the failed read reaches
 * better-auth, and refuses it 413 whatever is answered here.
 */
const cutOff = new WeakSet<Request>();

/** Marks `request` as one whose body passed the limit, so its failed read isn't logged as a fault (#1057). */
export function markBodyCutOff(request: Request): void {
  cutOff.add(request);
}

/**
 * better-auth's handler as the api serves it on `/api/auth/*` (#640), with the
 * answers better-auth gives without a stable code given one, alongside a
 * plain-language message, as every other refusal on these routes has.
 *
 * Each request runs with a record of whether a storage call failed while it
 * was answered (#894). better-auth catches some storage failures itself and
 * answers without the error, so the record, not the error, tells a storage
 * failure from a fault. The answers, in order:
 *
 * - **A throw, or any refusal (400 and up), after a storage failure.** 503
 *   with `AUTH_UNAVAILABLE`. That includes the limiter's count, which runs
 *   ahead of every hook; better-auth's own coded 500s, such as a session
 *   read's; and the 401 a route that requires a session answers when
 *   better-auth swallows the failed read and finds no session. A refusal
 *   reached on a failed storage can't be trusted, and a client must not take
 *   it as signed out (docs/REDIS.md). better-auth's headers are left off: a
 *   cookie it set or cleared rests on that same failed storage.
 * - **A throw with no storage failure.** 500 with `AUTH_FAILED`. better-auth
 *   rethrows any error that isn't its own (`onAPIError.throw`), where it would
 *   answer an empty 500.
 * - **A 500 with no code and no storage failure.** 500 with `AUTH_FAILED`
 *   too, so no request here answers a 500 a client can't announce: better-
 *   call answers an empty one, and better-auth answers one of its own internal
 *   errors with only an English message. better-auth's headers are kept, as
 *   they were on the 500 it gave.
 * - **A coded 500 with no storage failure.** Passed through: better-auth
 *   already gave it a code.
 * - **429.** better-auth's rate limiter answers with fixed English text and no
 *   code. It keeps its status and headers, `X-Retry-After` among them, and
 *   gets `RATE_LIMITED`. A 429 that already carries a code is left as it is.
 *
 * A throw is logged with its error, unless the request's body was cut off at
 * the limit: that is the client's doing, and the node handler answers it 413
 * (#1057). A 500 rewritten here is logged as a warning, naming the status it
 * replaced. Every other answer passes through
 * as better-auth gave it. Messages are rendered in the fallback locale, as
 * the settings gates' are: `/api/auth/*` runs ahead of Nest's i18n.
 */
export function createAuthRequestHandler(
  handler: AuthRequestHandler,
  deps: AuthRequestHandlerDeps,
): AuthRequestHandler {
  const logger = new Logger('AuthRequestHandler');
  const unavailable = () => coded(503, AUTH_UNAVAILABLE, deps.render('errors.auth.unavailable'));
  const failed = (headers?: Headers) => coded(500, AUTH_FAILED, deps.render('errors.auth.failed'), headers);

  return async (request) => {
    const record: StorageFailureRecord = { failed: false };

    let response: Response;
    try {
      response = await withStorageFailureRecord(record, () => handler(request));
    } catch (error) {
      if (!cutOff.has(request)) {
        logger.error('better-auth could not answer the request', error instanceof Error ? error.stack : error);
      }

      return record.failed ? unavailable() : failed();
    }

    if (record.failed && response.status >= 400) {
      logger.warn(`Answered 503 in place of better-auth's ${response.status}, after a storage call failed`);

      return unavailable();
    }

    if (response.status === 500 && !(await carriesCode(response))) {
      logger.warn("Answered AUTH_FAILED in place of better-auth's 500 with no code");

      return failed(response.headers);
    }

    if (response.status === 429 && !(await carriesCode(response))) {
      return coded(429, RATE_LIMITED, deps.render('errors.auth.rate_limited'), response.headers);
    }

    return response;
  };
}

/** Whether a response's JSON body names a `code`. */
async function carriesCode(response: Response): Promise<boolean> {
  try {
    const body: unknown = await response.clone().json();

    return typeof (body as { code?: unknown } | null)?.code === 'string';
  } catch {
    return false;
  }
}

/** A refusal with a stable code and a plain-language message, as every refusal on `/api/auth/*` is. */
export function coded(status: number, code: string, message: string, headers?: Headers): Response {
  const answer = new Headers(headers);
  answer.set('content-type', 'application/json');
  // Measured the body it replaces, not this one.
  answer.delete('content-length');

  return new Response(JSON.stringify({ code, message }), { status, headers: answer });
}
