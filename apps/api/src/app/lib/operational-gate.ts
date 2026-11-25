import { isOperationalRequest } from '@bge/health';
import type { I18nPath } from '@bge/i18n';
import { errorEnvelope } from '@bge/i18n';
import { Logger, RequestMethod } from '@nestjs/common';
import { Http } from '@status/codes';
import type { Request } from 'express';
import type { ServerResponse } from 'node:http';
import { createRefusalLog } from './refusal-log';

/** A route as `setGlobalPrefix`'s `exclude` takes one: Nest's `RouteInfo`, which its root doesn't export. */
export interface OperationalRoute {
  readonly method: RequestMethod;
  readonly path: string;
}

/**
 * The routes only the operational port answers (#1511), in Nest's path syntax.
 *
 * main.ts spreads these into the routes the global prefix skips, and the gate
 * reads its "operational only" class from the same list, so the two can't name
 * different routes. A `/*path` entry covers everything below its stem.
 */
export const OPERATIONAL_PATHS: readonly OperationalRoute[] = [
  { path: 'health', method: RequestMethod.GET },
  { path: 'metrics', method: RequestMethod.GET },
  { path: 'docs', method: RequestMethod.GET },
  { path: 'docs/*path', method: RequestMethod.GET },
];

/** The probes both ports answer: a platform's load balancer can only reach the public one (#1511). */
const EITHER_PORT_PATHS: ReadonlySet<string> = new Set(['/health/live', '/health/ready']);

const WILDCARD = '/*path';
const OPERATIONAL_EXACT: ReadonlySet<string> = new Set(
  OPERATIONAL_PATHS.filter(({ path }) => !path.endsWith(WILDCARD)).map(({ path }) => `/${path}`),
);
const OPERATIONAL_PREFIXES: readonly string[] = OPERATIONAL_PATHS.filter(({ path }) => path.endsWith(WILDCARD)).map(
  ({ path }) => `/${path.slice(0, -WILDCARD.length)}/`,
);

interface Refusal {
  readonly code: string;
  readonly key: I18nPath;
  readonly status: number;
}

const ROUTE_NOT_FOUND: Refusal = {
  code: 'ROUTE_NOT_FOUND',
  key: 'errors.request.route_not_found',
  status: Http.NotFound,
};

const SOURCE_NOT_ALLOWED: Refusal = {
  code: 'OPERATIONAL_SOURCE_NOT_ALLOWED',
  key: 'errors.operational.source_not_allowed',
  status: Http.Forbidden,
};

type PortRoutes = 'either' | 'operational' | 'public';

export interface OperationalGateDeps {
  readonly logger?: Pick<Logger, 'warn'>;

  /** Renders a catalog key. This runs ahead of Nest's i18n, so no request locale exists. */
  readonly render: (key: I18nPath) => string;

  /** Whether a peer address may reach the operational port (`createSourceRule`). */
  readonly sourceRule: (peer: string | undefined) => boolean;
}

/**
 * Keeps each of the api's two listeners to its own routes, and the operational
 * port to the networks allowed to reach it (#1511).
 *
 * One Express app serves both listeners, and the operational listener marks
 * each request it accepts (`markOperationalRequest`). A public request for an
 * operational-only route, or an operational request for any other route,
 * answers 404 `ROUTE_NOT_FOUND`, as an unmatched route does. An operational
 * request from a peer outside the allowed sources answers 403 for every path.
 * The peer is `req.socket.remoteAddress` alone: a forwarded header is the
 * client's to write, so it can't vouch for anyone.
 *
 * It classifies by Express's own `req.path`, so it must be mounted with a bare
 * `app.use(gate)` on the Express app: a `use` with a path strips that path from
 * `req.url`, and `req.path` with it. main.ts mounts it directly after the Host
 * check, so #977's rule stays the first answer on both listeners, and this one
 * still runs ahead of the better-auth mount and the web client.
 */
export function createOperationalGate({
  sourceRule,
  render,
  logger = new Logger('OperationalGate'),
}: OperationalGateDeps): (req: Request, res: ServerResponse, next: () => void) => void {
  const renderedMessages = new Map<I18nPath, string>();

  // Rendered at the first refusal, when the app is up, and then kept: the key and
  // the locale never change, and this path takes no session.
  const messageFor = (key: I18nPath): string => {
    let message = renderedMessages.get(key);
    if (message === undefined) {
      message = render(key);
      renderedMessages.set(key, message);
    }

    return message;
  };

  const refusalLog = createRefusalLog({
    logger,
    refused: (source) =>
      `Refused an operational request from ${source}. If it should reach the operational port, add its network to OPERATIONAL_SOURCES`,
    capReached: (max) =>
      `Refused operational requests from ${max} different addresses. Others are not logged for up to an hour`,
  });

  // A socket that has already closed reports no address; that case isn't quoted
  // as if it were one.
  const logRefusal = (peer: string | undefined): void => {
    refusalLog(peer === undefined ? 'an unknown address' : `'${peer}'`);
  };

  // Written before Nest sees the request, in the api's error envelope (#1260).
  const refuse = (res: ServerResponse, { code, key, status }: Refusal): void => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(errorEnvelope(status, messageFor(key), { code })));
  };

  return (req, res, next) => {
    const operational = isOperationalRequest(req);

    if (operational) {
      const peer = req.socket.remoteAddress;

      if (!sourceRule(peer)) {
        logRefusal(peer);
        refuse(res, SOURCE_NOT_ALLOWED);
        return;
      }
    }

    const routes = routesFor(req);

    if (routes !== 'either' && routes !== (operational ? 'operational' : 'public')) {
      refuse(res, ROUTE_NOT_FOUND);
      return;
    }

    next();
  };
}

function routesFor(req: Request): PortRoutes {
  const path = canonicalPath(req);

  if (path === undefined) {
    return 'public';
  }

  if (EITHER_PORT_PATHS.has(path)) {
    return 'either';
  }

  if (OPERATIONAL_EXACT.has(path) || OPERATIONAL_PREFIXES.some((prefix) => path.startsWith(prefix))) {
    return 'operational';
  }

  return 'public';
}

/**
 * The request's path in one spelling per route Express 5 could send it to
 * (#1511), or `undefined` when Express can read no path from the target.
 *
 * It starts from `req.path`, which is `parseurl(req).pathname`: the value
 * Express's router matches routes against. Re-reading the target here instead
 * would have to copy parseurl, which sends a target carrying `#` or not
 * starting with `/` through Node's legacy `url.parse`, with its own rules for
 * schemes, authorities and backslashes; a copy that misses one of them lets an
 * operational route answer on the public port.
 *
 * Express matches routes case-insensitively and allows one trailing slash, so
 * `/METRICS` and `/metrics/` reach `/metrics`, and the gate has to see them as
 * that route. A percent-encoded spelling (`/%6detrics`) is decoded too; Express
 * routes it nowhere, so counting it as the route it spells only moves its 404
 * earlier. A malformed escape is kept as sent, and Express answers 404 for it.
 * When `req.path` throws or is empty, the router can't route the request
 * either, and answers 404.
 */
function canonicalPath(req: Request): string | undefined {
  let routed: unknown;

  try {
    routed = req.path;
  } catch {
    return undefined;
  }

  if (typeof routed !== 'string' || routed === '') {
    return undefined;
  }

  const path = decodeOrKeep(routed).toLowerCase();

  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

function decodeOrKeep(path: string): string {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}
