import { request as httpRequest, type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import { requireBaseUrl } from '../support/e2e-env';

interface Answer {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

const KIB = 1024;

// Our own answer on `/api/auth/*`, in the api's error envelope (#1260).
const tooLarge = {
  statusCode: 413,
  error: 'Payload Too Large',
  code: 'REQUEST_TOO_LARGE',
  message: 'This request was too large for the server to read, so nothing was changed',
};

/**
 * The body limit on `/api/auth/*` (#1057), on the shipped bundle: a body over
 * 64 KiB is refused before it is read in full, whether it declares its length
 * or arrives in chunks. Checked on a route better-auth parses and on app
 * sign-in's token route, which reads its own body (#1019).
 *
 * The token route allows 3 requests per 10 seconds. This spec sends it two,
 * and the one that declares its length never reaches the limiter.
 */
describe.each([['/api/auth/sign-in/email'], ['/api/auth/app-sign-in/token']])(
  'the body limit on %s (#1057)',
  (path) => {
    const { hostname, port } = new URL(requireBaseUrl(process.env));

    /**
     * Sends a POST, lets `write` send its body, and resolves with the answer as
     * soon as it has arrived, whether or not the body was ended. A write the
     * server no longer reads may fail once it has answered, which is ignored.
     */
    function post(headers: Record<string, string | number>, write: (request: ClientRequest) => void): Promise<Answer> {
      return new Promise((resolve, reject) => {
        const request = httpRequest({ hostname, port, path, method: 'POST', headers });
        request.on('error', () => undefined);
        request.on('response', (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (body += chunk));
          response.on('end', () => {
            resolve({ status: response.statusCode ?? 0, headers: response.headers, body });
            request.destroy();
          });
          response.on('error', reject);
        });
        write(request);
      });
    }

    it('refuses a body declaring more than 64 KiB, unread (#1057)', async () => {
      const answer = await post({ 'content-type': 'application/json', 'content-length': 64 * KIB + 1 }, (request) =>
        request.flushHeaders(),
      );

      expect(answer.status).toBe(413);
      expect(JSON.parse(answer.body)).toEqual(tooLarge);
    });

    it('refuses a chunked body growing past 64 KiB, before it ends (#1057)', async () => {
      // The body is never ended, so an answer at all shows the server didn't
      // wait for the rest of it.
      const answer = await post({ 'content-type': 'application/json', 'transfer-encoding': 'chunked' }, (request) => {
        for (let sent = 0; sent < 70 * KIB; sent += 4 * KIB) {
          request.write('x'.repeat(4 * KIB));
        }
      });

      expect(answer.status).toBe(413);
      expect(JSON.parse(answer.body)).toEqual(tooLarge);
    });
  },
);
