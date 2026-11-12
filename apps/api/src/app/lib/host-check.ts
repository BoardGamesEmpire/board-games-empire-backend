import { errorEnvelope, type I18nPath } from '@bge/i18n';
import { Logger } from '@nestjs/common';
import { Http } from '@status/codes';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { HostRule } from './host-rule';

const REFUSAL_CODE = 'HOST_NOT_ALLOWED';
const REFUSAL_MESSAGE_KEY: I18nPath = 'errors.host.not_allowed';

/** The longest a DNS name can be, and so the most of one worth logging. */
const MAX_LOGGED_NAME_LENGTH = 253;
const MAX_LOGGED_NAMES = 100;
const LOG_WINDOW_MS = 60 * 60 * 1000;

export interface HostCheckDeps {
  readonly rule: HostRule;
  /** Renders a catalog key. This runs ahead of Nest's i18n, so no request locale exists. */
  readonly render: (key: I18nPath) => string;
  readonly logger?: Pick<Logger, 'warn'>;
}

export interface HostCheck {
  /** For the Express app: REST, `/api/auth/*`, the OpenAPI routes and the web client. */
  readonly handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
  /** For engine.io, which answers `/socket.io/` ahead of Express. */
  readonly allowRequest: (
    req: IncomingMessage,
    callback: (message: string | undefined, success: boolean) => void,
  ) => void;
}

/**
 * The two places a request can reach the api, answering by one rule (#977).
 *
 * Both read `req.headers.host` and never Express's `req.hostname`: `trust proxy`
 * makes that prefer `X-Forwarded-Host`, which a rebound page can set on its own
 * `fetch`.
 *
 * A refused name is logged so an operator can see which address to add. The log
 * remembers each name once and stops at a cap, so someone sending endless
 * distinct names can't flood it or grow this set. It starts over each hour, so
 * outside traffic filling the cap can't hide a name the operator later needs.
 */
export function createHostCheck({ rule, render, logger = new Logger('HostCheck') }: HostCheckDeps): HostCheck {
  const loggedNames = new Set<string>();
  let capReported = false;
  let logWindowStart = Date.now();
  let renderedMessage: string | undefined;

  // Rendered at the first refusal, when the app is up, and then kept: the key and
  // the locale never change, and this path takes no session.
  const refusalMessage = (): string => (renderedMessage ??= render(REFUSAL_MESSAGE_KEY));

  const logRefusal = (host: string | undefined): void => {
    const name = String(host).slice(0, MAX_LOGGED_NAME_LENGTH);
    const now = Date.now();

    if (now - logWindowStart >= LOG_WINDOW_MS) {
      logWindowStart = now;
      loggedNames.clear();
      capReported = false;
    }

    if (loggedNames.has(name)) {
      return;
    }

    if (loggedNames.size < MAX_LOGGED_NAMES) {
      loggedNames.add(name);
      logger.warn(`Refused a request for '${name}'. If this server answers there, add it to TRUSTED_ORIGINS`);
      return;
    }

    if (!capReported) {
      capReported = true;
      logger.warn(`Refused requests for ${MAX_LOGGED_NAMES} different names. Others are not logged for up to an hour`);
    }
  };

  const isAllowed = (req: IncomingMessage): boolean => {
    const { host } = req.headers;
    if (rule(host)) {
      return true;
    }

    logRefusal(host);
    return false;
  };

  return {
    handler: (req, res, next) => {
      if (isAllowed(req)) {
        next();
        return;
      }

      // Written before Nest sees the request, in the api's error envelope (#1260).
      res.statusCode = Http.MisdirectedRequest;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(errorEnvelope(Http.MisdirectedRequest, refusalMessage(), { code: REFUSAL_CODE })));
    },

    // engine.io has its own refusal shape, so the code travels in the message.
    allowRequest: (req, callback) => {
      if (isAllowed(req)) {
        callback(undefined, true);
        return;
      }

      callback(`${REFUSAL_CODE}: ${refusalMessage()}`, false);
    },
  };
}
