import type { I18nPath } from '@bge/i18n';
import { Logger } from '@nestjs/common';

/** better-auth's fetch handler: a request in, a response out. */
export type AuthRequestHandler = (request: Request) => Promise<Response>;

export interface AuthRequestHandlerDeps {
  /** Renders a refusal's catalog key. */
  readonly render: (key: I18nPath) => string;
}

/** The stable code a rate-limited request carries, so a client can announce or rephrase it. */
const RATE_LIMITED = 'RATE_LIMITED';

/** The stable code a request better-auth could not answer carries. */
const AUTH_UNAVAILABLE = 'AUTH_UNAVAILABLE';

/**
 * better-auth's handler as the api serves it on `/api/auth/*` (#640), with the
 * two answers better-auth gives without a stable code given one, alongside a
 * plain-language message, as every other refusal on these routes has.
 *
 * - **429.** better-auth's rate limiter answers with fixed English text and no
 *   code. It keeps its status and headers, `X-Retry-After` among them, and
 *   gets `RATE_LIMITED`. A 429 that already carries a code is left as it is.
 * - **A request better-auth could not answer.** Its limiter counts the request
 *   in the store ahead of every hook, outside better-auth's own error handling,
 *   so with Redis unreachable the handler throws and Express would answer a
 *   bare 500. It is answered 503 with `AUTH_UNAVAILABLE` instead, and logged.
 *
 * Every other answer passes through as better-auth gave it. Messages are
 * rendered in the fallback locale, as the settings gates' are: `/api/auth/*`
 * runs ahead of Nest's i18n.
 */
export function createAuthRequestHandler(
  handler: AuthRequestHandler,
  deps: AuthRequestHandlerDeps,
): AuthRequestHandler {
  const logger = new Logger('AuthRequestHandler');

  return async (request) => {
    let response: Response;
    try {
      response = await handler(request);
    } catch (error) {
      logger.error('better-auth could not answer the request', error instanceof Error ? error.stack : error);

      return coded(503, AUTH_UNAVAILABLE, deps.render('errors.auth.unavailable'));
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

function coded(status: number, code: string, message: string, headers?: Headers): Response {
  const answer = new Headers(headers);
  answer.set('content-type', 'application/json');

  return new Response(JSON.stringify({ code, message }), { status, headers: answer });
}
