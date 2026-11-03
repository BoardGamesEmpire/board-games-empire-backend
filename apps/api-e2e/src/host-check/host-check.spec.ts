import { request as httpRequest, type IncomingMessage, type OutgoingHttpHeaders } from 'node:http';
import { connect as netConnect } from 'node:net';
import request from 'supertest';
import { API_CONFIGURED_SERVER_NAME, requireBaseUrl } from '../support/e2e-env';

const REFUSED_CODE = 'HOST_NOT_ALLOWED';
const FOREIGN_NAME = 'evil.example';
const POLLING_HANDSHAKE = '/socket.io/?EIO=4&transport=polling';
const WEBSOCKET_HANDSHAKE = '/socket.io/?EIO=4&transport=websocket';

interface RawAnswer {
  readonly status: number;
  readonly body: string;
}

/**
 * The inbound Host check, on the shipped bundle (#977). The check sits on the
 * Express app and on engine.io, and only a running server shows that both
 * answer ahead of everything else on the listener.
 *
 * Every refusal asserts the code and not only the status, so a 421 or 403 from
 * anywhere else can't pass it.
 */
describe('the inbound Host check (#977)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { hostname, port } = new URL(baseUrl);

  /** `node:http`, for the Socket.IO answers that supertest would misread as an upgrade. */
  function rawGet(path: string, headers: OutgoingHttpHeaders = {}): Promise<RawAnswer> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ hostname, port, path, headers }, (res: IncomingMessage) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      });

      req.on('upgrade', () => reject(new Error('the websocket handshake was accepted')));
      req.on('error', reject);
      req.end();
    });
  }

  /**
   * A request written byte for byte, for the Host headers `node:http` won't
   * send: none at all, or one with no value. Answers the whole response.
   */
  function rawExchange(raw: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = netConnect({ host: hostname, port: Number(port) }, () => socket.write(raw));
      let received = '';

      socket.setEncoding('utf8');
      socket.on('data', (chunk: string) => (received += chunk));
      socket.on('end', () => resolve(received));
      socket.on('error', reject);
    });
  }

  describe("a request for a name that is not the server's", () => {
    it.each(['/health/live', '/metrics', '/api/games', '/no-such-path'])('refuses %s', async (path) => {
      const response = await request(baseUrl).get(path).set('Host', FOREIGN_NAME);

      expect(response.status).toBe(421);
      expect(response.body.code).toBe(REFUSED_CODE);
      expect(response.body.message).toEqual(expect.any(String));
      expect(response.text).not.toContain(FOREIGN_NAME);
    });

    it('refuses /api/auth/get-session, which skips Nest middleware', async () => {
      const response = await request(baseUrl).get('/api/auth/get-session').set('Host', FOREIGN_NAME);

      expect(response.status).toBe(421);
      expect(response.body.code).toBe(REFUSED_CODE);
    });

    // `trust proxy` is on, so `req.hostname` would believe this header, and a
    // rebound page can set it on its own fetch.
    it('refuses a forged X-Forwarded-Host carrying the real name', async () => {
      const response = await request(baseUrl)
        .get('/health/live')
        .set('Host', FOREIGN_NAME)
        .set('X-Forwarded-Host', 'localhost');

      expect(response.status).toBe(421);
      expect(response.body.code).toBe(REFUSED_CODE);
    });

    it('refuses a Socket.IO polling handshake', async () => {
      const answer = await rawGet(POLLING_HANDSHAKE, { Host: FOREIGN_NAME });

      expect(answer.status).toBe(403);
      expect(JSON.parse(answer.body).message).toContain(REFUSED_CODE);
    });

    // engine.io answers a refused upgrade with its own fixed 400, whatever the
    // reason, and the 403 only on polling. The code is what identifies this
    // refusal, and it reaches the client in the body.
    it('refuses a Socket.IO websocket handshake', async () => {
      const answer = await rawGet(WEBSOCKET_HANDSHAKE, {
        Host: FOREIGN_NAME,
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      });

      expect(answer.status).toBe(400);
      expect(answer.body).toContain(REFUSED_CODE);
    });

    // Node passes `Host:` with no value on as '', unlike a missing Host, which
    // it answers with its own 400 on HTTP/1.1. The check must refuse it itself.
    it('refuses a request whose Host is empty', async () => {
      const answer = await rawExchange('GET /health/live HTTP/1.1\r\nHost:\r\nConnection: close\r\n\r\n');
      const [head, body] = answer.split('\r\n\r\n');

      expect(head.split('\r\n')[0]).toContain('421');
      expect(JSON.parse(body).code).toBe(REFUSED_CODE);
    });

    // engine.io's allowRequest runs only for a handshake, and Socket.IO answers
    // its client files ahead of that, so these aren't served at any name.
    it.each(['/socket.io/socket.io.js', '/socket.io/socket.io.min.js.map'])("doesn't serve %s", async (path) => {
      const answer = await rawGet(path, { Host: FOREIGN_NAME });

      expect(answer.status).toBe(400);
      expect(answer.body).not.toContain('function');
    });
  });

  describe('a request the check lets through', () => {
    it.each(['localhost:1234', '127.0.0.1', '[::1]:1234', '203.0.113.9'])('answers %s', async (host) => {
      const response = await request(baseUrl).get('/health/live').set('Host', host);

      expect(response.status).toBe(200);
    });

    // Every other name here passes without reading configuration, so this is the
    // one case that fails if main.ts stops handing the rule its server names.
    it('answers a name from TRUSTED_ORIGINS', async () => {
      const response = await request(baseUrl).get('/health/live').set('Host', `${API_CONFIGURED_SERVER_NAME}:8443`);

      expect(response.status).toBe(200);
    });

    it('answers an HTTP/1.0 request with no Host', async () => {
      const answer = await rawExchange('GET /health/live HTTP/1.0\r\n\r\n');

      expect(answer.split('\r\n')[0]).toContain('200');
    });

    it("still completes a Socket.IO handshake for the server's name", async () => {
      const answer = await rawGet(POLLING_HANDSHAKE);

      expect(answer.status).toBe(200);
      expect(answer.body).toContain('"sid"');
    });
  });
});
