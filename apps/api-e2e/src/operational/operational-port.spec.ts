import request from 'supertest';
import { requireBaseUrl, requireOperationalUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import { rawExchange } from '../support/raw-exchange';

/**
 * Request targets that Express routes to `/metrics` though they aren't spelled
 * `/metrics`: it reads the path as Node's legacy URL parser does, which ends it
 * at a `#`, turns a backslash before that into a slash, and reads a target that
 * then starts `//` as an authority followed by the path. Node's HTTP parser
 * passes each through untouched, and supertest can't send them, so they go
 * byte for byte (#1511).
 */
const METRICS_BY_FRAGMENT = '/metrics#x';

/**
 * Bare Express routes these to `/metrics` too, but the shipped api routes them
 * nowhere: on the operational port, where the gate lets them through, Nest
 * answers its own 404. That is by accident. `app.module.ts` applies
 * `ClsMiddleware` and the others with `forRoutes('*')`, which Nest mounts as a
 * path-mounted Express `use`, and the router's prefix trimming for that mount
 * garbles `req.url` for a target with userinfo, so no route matches it after.
 * The gate is the real defence: `operational-gate.spec.ts` pins that it
 * refuses them itself. So no positive control exists for them here, and on
 * the public port they pin only that the metrics are never served (#1511).
 */
const METRICS_BY_AUTHORITY = ['//x@y/metrics#z', '/\\u@h/metrics#x'];

interface RawAnswer {
  readonly body: string;
  readonly statusLine: string;
}

async function rawGet(url: string, target: string): Promise<RawAnswer> {
  const answer = await rawExchange(url, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
  const headEnd = answer.indexOf('\r\n\r\n');

  return { statusLine: answer.slice(0, answer.indexOf('\r\n')), body: answer.slice(headEnd + 4) };
}

/**
 * The api's two listeners, on the shipped bundle (#1511). One Express app
 * serves both, so only a running server shows that each port answers its own
 * routes and refuses the other's.
 *
 * The refusal of a peer outside the allowed sources can't be produced here:
 * every request in the suite comes from loopback, which the default sources
 * allow. `operational-gate.spec.ts` pins that refusal instead.
 */
describe('the operational port (#1511)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const operationalUrl = requireOperationalUrl(process.env);

  describe('the public port', () => {
    it('answers the liveness probe, which a platform load balancer can only reach here', async () => {
      const response = await request(baseUrl).get('/health/live');

      expect(response.status).toBe(200);
    });

    it.each(['/metrics', '/health', '/docs/json'])(
      'refuses %s, which only the operational port answers',
      async (path) => {
        const response = await request(baseUrl).get(path);

        expectErrorEnvelope(response, { status: 404, code: 'ROUTE_NOT_FOUND' });
      },
    );

    // For METRICS_BY_FRAGMENT, the operational port's answer to the same
    // target, below, is the positive control: it serves the metrics, so this
    // 404 is the gate's. The METRICS_BY_AUTHORITY targets have none (see their
    // docblock), and Nest's own unmatched-route 404 carries this code too.
    it.each([METRICS_BY_FRAGMENT, ...METRICS_BY_AUTHORITY])(
      'refuses %s, which Express would route to the metrics',
      async (target) => {
        const answer = await rawGet(baseUrl, target);

        expect(answer.statusLine).toBe('HTTP/1.1 404 Not Found');
        expect(answer.body).not.toContain('bge_process_cpu');
        expect(JSON.parse(answer.body)).toMatchObject({ statusCode: 404, code: 'ROUTE_NOT_FOUND' });
      },
    );

    // helmet's defaults, as before the operational port existed.
    it('asks the browser to upgrade insecure requests, and sends HSTS', async () => {
      const response = await request(baseUrl).get('/health/live');

      expect(response.headers['content-security-policy']).toContain('upgrade-insecure-requests');
      expect(response.headers['strict-transport-security']).toEqual(expect.any(String));
    });

    it('no longer serves the API document under the global prefix', async () => {
      const response = await request(baseUrl).get('/api/swagger/json');

      expect(response.status).toBe(404);
    });

    // better-auth's open-api plugin is always on, for the auth half of the API
    // document, and its own routes sit under `/api/auth`, which this port
    // serves. They must answer nothing, or the schema the operational port
    // keeps to itself would be public.
    it.each(['/api/auth/open-api/generate-schema', '/api/auth/reference'])(
      "refuses %s, better-auth's own copy of its schema",
      async (path) => {
        const response = await request(baseUrl).get(path);

        expect(response.status).toBe(404);
      },
    );
  });

  describe('the operational port', () => {
    it('serves the metrics in the Prometheus text format', async () => {
      const response = await request(operationalUrl).get('/metrics');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/plain/);
      expect(response.text).toContain('bge_process_cpu');
    });

    // The harness names no URL to ping (`apiEnvOverrides`), so the report is
    // the full Terminus result with nothing in it, and no third party is reached.
    it('serves the full health report', async () => {
      const response = await request(operationalUrl).get('/health');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok', info: {}, error: {}, details: {} });
    });

    it(`serves the metrics for ${METRICS_BY_FRAGMENT}, as Express routes it`, async () => {
      const answer = await rawGet(operationalUrl, METRICS_BY_FRAGMENT);

      // The whole answer, so a failure shows whose 404 it was.
      expect(answer).toMatchObject({ statusLine: 'HTTP/1.1 200 OK', body: expect.stringContaining('bge_process_cpu') });
    });

    // Built on this first request, with better-auth's half merged in.
    it('serves the API document as JSON, with the routes of both halves', async () => {
      const response = await request(operationalUrl).get('/docs/json');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^application\/json/);
      expect(response.body.openapi).toMatch(/^3\./);
      expect(Object.keys(response.body.paths)).toContain('/api/games');
      expect(Object.keys(response.body.paths).some((path) => path.startsWith('/api/auth/'))).toBe(true);
    });

    it('serves the API document as YAML', async () => {
      const response = await request(operationalUrl).get('/docs/yaml');

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/yaml/);
      expect(response.text).toMatch(/^openapi: /m);
    });

    it.each([
      ['/docs', /^text\/html/],
      ['/docs/swagger-ui-init.js', /^application\/javascript/],
    ])("serves the API document's page at %s", async (path, contentType) => {
      const response = await request(operationalUrl).get(path);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(contentType);
    });

    // The port is plain HTTP. An upgrade would send the page's script and style
    // to an https:// that nothing serves, and the page would render blank.
    it("serves the API document's page without asking the browser to upgrade to https", async () => {
      const response = await request(operationalUrl).get('/docs');

      expect(response.status).toBe(200);
      expect(response.headers['content-security-policy']).toContain("default-src 'self'");
      expect(response.headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
      expect(response.headers).not.toHaveProperty('strict-transport-security');
    });

    it.each(['/api/games', '/socket.io/?EIO=4&transport=polling'])(
      'refuses %s, which only the public port answers',
      async (path) => {
        const response = await request(operationalUrl).get(path);

        expectErrorEnvelope(response, { status: 404, code: 'ROUTE_NOT_FOUND' });
      },
    );

    // The Host check (#977) runs ahead of the port's own rules, on both listeners.
    it("refuses a request for a name that is not the server's", async () => {
      const response = await request(operationalUrl).get('/metrics').set('Host', 'evil.example');

      expectErrorEnvelope(response, { status: 421, code: 'HOST_NOT_ALLOWED' });
    });
  });

  // The same route answers both ports with different bodies, so a dependency's
  // name and message reach only whoever can reach the operational port (#1511).
  describe('readiness on each port', () => {
    it('answers its status only on the public port', async () => {
      const response = await request(baseUrl).get('/health/ready');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('answers the full report on the operational port', async () => {
      const response = await request(operationalUrl).get('/health/ready');

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: 'ok',
        info: { database: { status: 'up' } },
      });
    });
  });
});
