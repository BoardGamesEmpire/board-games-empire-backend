import { markOperationalRequest } from '@bge/health';
import type { I18nPath } from '@bge/i18n';
import { errorEnvelope } from '@bge/i18n';
import { RequestMethod } from '@nestjs/common';
import type { Request } from 'express';
import express from 'express';
import type { ServerResponse } from 'node:http';
import { createOperationalGate, OPERATIONAL_PATHS } from './operational-gate';
import { createSourceRule, DEFAULT_OPERATIONAL_SOURCES } from './operational-sources';

const ALLOWED_PEER = '10.0.0.5';
const REFUSED_PEER = '8.8.8.8';

interface RequestOptions {
  readonly headers?: Record<string, string>;
  readonly operational?: boolean;
  readonly peer?: string;
}

/**
 * A request built on Express's own request prototype, so `req.path` is
 * Express's getter and each test exercises the parse its router matches on.
 */
function request(
  url: string | undefined,
  { headers = {}, operational = false, peer = ALLOWED_PEER }: RequestOptions = {},
): Request {
  const req: Request = Object.setPrototypeOf({ url, headers, socket: { remoteAddress: peer } }, express.request);

  if (operational) {
    markOperationalRequest(req);
  }

  return req;
}

/** An operational request for `/metrics` on a socket that reports no peer, as a closed one does. */
function withoutPeer(): Request {
  const req: Request = Object.setPrototypeOf({ url: '/metrics', headers: {}, socket: {} }, express.request);
  markOperationalRequest(req);

  return req;
}

function response() {
  const headers = new Map<string, string>();
  const end = jest.fn();

  return {
    end,
    headers,
    body: () => JSON.parse(end.mock.calls[0][0]),
    res: {
      statusCode: 200,
      setHeader: (name: string, value: string) => headers.set(name.toLowerCase(), value),
      end,
    } as unknown as ServerResponse,
  };
}

const ROUTE_NOT_FOUND = errorEnvelope(404, 'rendered:errors.request.route_not_found', { code: 'ROUTE_NOT_FOUND' });
const SOURCE_NOT_ALLOWED = errorEnvelope(403, 'rendered:errors.operational.source_not_allowed', {
  code: 'OPERATIONAL_SOURCE_NOT_ALLOWED',
});

/** The spellings of an operational-only route, each of which Express 5 routes to it or answers 404 for. */
const OPERATIONAL_SPELLINGS = [
  '/health',
  '/health/',
  '/HEALTH',
  '/Health/',
  '/metrics',
  '/metrics/',
  '/METRICS',
  '/metrics?x=1',
  '/%6detrics',
  '/docs',
  '/docs/',
  '/docs/json',
  '/docs/JSON',
  '/DOCS/json',
  '/docs/json/',
  '/docs/yaml',
  '/docs/swagger-ui.css',
  '/docs/swagger-ui%2Ecss',
  '/docs%2Fjson',
];

/**
 * Request targets Express 5 routes to an operational route although a cut at
 * the first `?` would not find it there. Express reads the path through
 * `parseurl`, and a target carrying `#` or not starting with `/` goes through
 * Node's legacy `url.parse`. That ends the path at the `#`, turns backslashes
 * into slashes, keeps only the path after an absolute-form target's authority
 * (`GET http://host/metrics`), and reads `//user@host/…` as an authority too,
 * routing what follows the host. The gate reads Express's own `req.path`, so
 * these are examples rather than a list it depends on. Each answered from the
 * operational route on a live Express 5.2.1 app (#1511).
 */
const OPERATIONAL_SPELLINGS_EXPRESS_PARSES = [
  '/metrics#x',
  '/metrics?#',
  '/metrics#?x',
  '/metrics\\#x',
  '/docs\\json#x',
  'http://evil.example/metrics',
  'HTTPS://evil.example:1/METRICS?y',
  'http:///metrics',
  'http://user@evil.example/metrics',
  'ftp://evil.example/metrics',
  'x://evil.example/docs\\json',
  'http://evil.example/docs/json',
  '//user@h/metrics#x',
  '/\\user@h/metrics#x',
  '//a@h\\metrics#',
  '//u@h/METRICS/#a',
  '//a@h/metrics?x=1#y',
  '//a@b@c/metrics#',
  '//a@[::1]/metrics#',
  '//a@h:80/metrics#',
  '//a@h:99999/metrics#',
  '//a%40h@h/metrics#',
  '//u@h/health#',
  '//u:p@h/docs#',
  '//u@h/docs/json#',
  '/\\a@h/docs/yaml#',
  '//a@h/DOCS/JSON/#',
  '//a@h/Health/#',
];

const BOTH_PORTS = [
  '/health/live',
  '/health/ready',
  '/health/ready?x=1',
  '/health/live/',
  '/HEALTH/Ready',
  '//a@h/health/live#',
];

/**
 * Targets Express 5 routes to no operational route: its router matches the
 * raw path, keeps extra slashes and dot segments, and decodes nothing before
 * matching. `//user@h/metrics` without a `#` takes parseurl's fast path, which
 * keeps the whole of it as the path; `url.parse` reads an authority only from
 * `//` followed by `user@host`. Each was checked on a live Express 5.2.1 app
 * (#1511).
 */
const ROUTED_NOWHERE_OPERATIONAL = [
  '//metrics',
  '/metrics//',
  '/metrics/.',
  '/health//',
  '/metrics%23x',
  '/metrics;x',
  '*',
  '//user@h/metrics',
  '//h/metrics#x',
  '///u@h/metrics#',
  '//a@h?/metrics#',
  '//a@h#/metrics',
  'http:////metrics',
];

describe('createOperationalGate (#1511)', () => {
  const warn = jest.fn();
  const render = (key: I18nPath) => `rendered:${key}`;
  const sourceRule = createSourceRule(DEFAULT_OPERATIONAL_SOURCES);

  beforeEach(() => warn.mockClear());

  const gateFor = () => createOperationalGate({ sourceRule, render, logger: { warn } });

  /** Runs a request through the gate and reports what it did. */
  function handle(req: Request, gate = gateFor()) {
    const answer = response();
    const next = jest.fn();

    gate(req, answer.res, next);

    return { ...answer, next };
  }

  function expectPassed(outcome: ReturnType<typeof handle>) {
    expect(outcome.next).toHaveBeenCalledTimes(1);
    expect(outcome.end).not.toHaveBeenCalled();
    expect(outcome.headers.size).toBe(0);
    expect(outcome.res.statusCode).toBe(200);
  }

  function expectRefused(outcome: ReturnType<typeof handle>, status: number, envelope: object) {
    expect(outcome.next).not.toHaveBeenCalled();
    expect(outcome.res.statusCode).toBe(status);
    expect(outcome.headers.get('content-type')).toBe('application/json');
    expect(outcome.body()).toEqual(envelope);
  }

  describe('on the public port', () => {
    it.each([...BOTH_PORTS, '/api/games', '/', '/socket.io/', '/api/auth/ok'])('passes %s on', (url) => {
      expectPassed(handle(request(url)));
    });

    // Prefix neighbours of the operational routes, which Express routes elsewhere.
    it.each(['/healthz', '/metricsfoo', '/docsfoo', '/docs-json', '/healthy/live'])(
      'passes %s on, though it starts like an operational route',
      (url) => {
        expectPassed(handle(request(url)));
      },
    );

    // Express 5 matches case-insensitively and allows one trailing slash, so each
    // of these reaches the route its canonical spelling names.
    it.each(OPERATIONAL_SPELLINGS)('answers %s with 404 ROUTE_NOT_FOUND', (url) => {
      expectRefused(handle(request(url)), 404, ROUTE_NOT_FOUND);
    });

    it.each(OPERATIONAL_SPELLINGS_EXPRESS_PARSES)('answers %s with 404 ROUTE_NOT_FOUND, as Express reads it', (url) => {
      expectRefused(handle(request(url)), 404, ROUTE_NOT_FOUND);
    });

    // Passing these on leaves the 404 to Nest.
    it.each(ROUTED_NOWHERE_OPERATIONAL)('passes %s on, which Express routes to no operational route', (url) => {
      expectPassed(handle(request(url)));
    });

    it('passes a malformed escape on without throwing', () => {
      expectPassed(handle(request('/%E0%A4%A')));
    });

    // With no target, `req.path` throws, and the router answers 404 itself.
    it('passes a request whose path Express can not read on', () => {
      expectPassed(handle(request(undefined)));
    });

    it('never checks the peer of a public request', () => {
      expectPassed(handle(request('/api/games', { peer: REFUSED_PEER })));
    });
  });

  describe('on the operational port, from an allowed peer', () => {
    const operational = (url: string, peer = ALLOWED_PEER) => request(url, { operational: true, peer });

    it.each([...OPERATIONAL_SPELLINGS, ...OPERATIONAL_SPELLINGS_EXPRESS_PARSES, ...BOTH_PORTS])(
      'passes %s on',
      (url) => {
        expectPassed(handle(operational(url)));
      },
    );

    it.each([
      '/api/games',
      '/',
      '/socket.io/',
      '/api/auth/ok',
      '/healthz',
      '/metricsfoo',
      'http://evil.example/api/games',
    ])('answers %s with 404 ROUTE_NOT_FOUND', (url) => {
      expectRefused(handle(operational(url)), 404, ROUTE_NOT_FOUND);
    });

    it.each(ROUTED_NOWHERE_OPERATIONAL)('answers %s with 404 ROUTE_NOT_FOUND', (url) => {
      expectRefused(handle(operational(url)), 404, ROUTE_NOT_FOUND);
    });

    it('answers a malformed escape with 404 ROUTE_NOT_FOUND, without throwing', () => {
      expectRefused(handle(operational('/%E0%A4%A')), 404, ROUTE_NOT_FOUND);
    });

    it('answers a request whose path Express can not read with 404 ROUTE_NOT_FOUND', () => {
      expectRefused(handle(request(undefined, { operational: true })), 404, ROUTE_NOT_FOUND);
    });

    // Node reports an IPv4 peer on a dual-stack socket in its IPv6 form.
    it('passes an IPv4-mapped IPv6 peer on', () => {
      expectPassed(handle(operational('/metrics', '::ffff:127.0.0.1')));
    });
  });

  describe('on the operational port, from a refused peer', () => {
    const refused = (url: string, options: RequestOptions = {}) =>
      request(url, { operational: true, peer: REFUSED_PEER, ...options });

    it.each([...OPERATIONAL_SPELLINGS, ...BOTH_PORTS, '/api/games', '/'])(
      'answers %s with 403 OPERATIONAL_SOURCE_NOT_ALLOWED',
      (url) => {
        expectRefused(handle(refused(url)), 403, SOURCE_NOT_ALLOWED);
      },
    );

    // A forwarded header is the client's to write, so it can't vouch for a peer.
    it('reads the socket peer, not X-Forwarded-For', () => {
      const outcome = handle(refused('/metrics', { headers: { 'x-forwarded-for': ALLOWED_PEER } }));

      expectRefused(outcome, 403, SOURCE_NOT_ALLOWED);
    });

    it('refuses a request whose socket has no peer address', () => {
      expectRefused(handle(withoutPeer()), 403, SOURCE_NOT_ALLOWED);
    });

    it('never echoes the peer in the answer', () => {
      const { end } = handle(refused('/metrics'));

      expect(end.mock.calls[0][0]).not.toContain(REFUSED_PEER);
    });
  });

  // The renderer logs an error when it fails, and this path takes no session,
  // so a render per refusal would get around the cap on the log.
  it('renders each message once, however many requests it refuses', () => {
    const render = jest.fn((key: I18nPath) => `rendered:${key}`);
    const gate = createOperationalGate({ sourceRule, render, logger: { warn } });

    handle(request('/metrics'), gate);
    handle(request('/metrics'), gate);
    handle(request('/metrics', { operational: true, peer: REFUSED_PEER }), gate);
    handle(request('/metrics', { operational: true, peer: REFUSED_PEER }), gate);

    expect(render).toHaveBeenCalledTimes(2);
    expect(render).toHaveBeenCalledWith('errors.request.route_not_found');
    expect(render).toHaveBeenCalledWith('errors.operational.source_not_allowed');
  });

  describe('the log of refused peers', () => {
    const refused = (peer: string) => request('/metrics', { operational: true, peer });

    it('logs each refused peer once, naming the variable to change', () => {
      const gate = gateFor();

      handle(refused(REFUSED_PEER), gate);
      handle(refused(REFUSED_PEER), gate);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(REFUSED_PEER);
      expect(warn.mock.calls[0][0]).toContain('OPERATIONAL_SOURCES');
    });

    it('logs nothing for a refused path', () => {
      handle(request('/metrics'));
      handle(request('/api/games', { operational: true }));

      expect(warn).not.toHaveBeenCalled();
    });

    it('writes the refused peer and the cap notice as an operator reads them', () => {
      const gate = gateFor();

      for (let peer = 0; peer < 101; peer++) {
        handle(refused(`2001:db8::${peer.toString(16)}`), gate);
      }

      expect(warn.mock.calls[0][0]).toBe(
        "Refused an operational request from '2001:db8::0'. If it should reach the operational port, add its network to OPERATIONAL_SOURCES",
      );
      expect(warn.mock.calls[100][0]).toBe(
        'Refused operational requests from 100 different addresses. Others are not logged for up to an hour',
      );
    });

    // A closed socket reports no address, and quoting a phrase would read as one.
    it('names a peer with no address without quoting it', () => {
      handle(withoutPeer());

      expect(warn).toHaveBeenCalledWith(
        'Refused an operational request from an unknown address. If it should reach the operational port, add its network to OPERATIONAL_SOURCES',
      );
    });
  });

  describe('OPERATIONAL_PATHS', () => {
    // main.ts spreads these into the routes the global prefix skips, so the
    // gate and that list can't name different routes.
    it('names the routes only the operational port answers, in Nest path syntax', () => {
      expect(OPERATIONAL_PATHS).toEqual([
        { path: 'health', method: RequestMethod.GET },
        { path: 'metrics', method: RequestMethod.GET },
        { path: 'docs', method: RequestMethod.GET },
        { path: 'docs/*path', method: RequestMethod.GET },
      ]);
    });

    it.each(OPERATIONAL_PATHS.map(({ path }) => `/${path.replace('*path', 'anything')}`))(
      'keeps %s off the public port and on the operational port',
      (url) => {
        expectRefused(handle(request(url)), 404, ROUTE_NOT_FOUND);
        expectPassed(handle(request(url, { operational: true })));
      },
    );
  });
});
