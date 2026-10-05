import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const TOKEN_PATH = '/oauth2/token';

export interface TokenEndpoint {
  /** The URL to hand the gateway as `IGDB_TOKEN_URL`. */
  url(): string;

  /** The query of every token request received so far, in order. */
  requests(): readonly Record<string, string>[];
}

export interface TokenEndpointOptions {
  /** Answer every token request with this status and no token, so the gateway's boot fails. */
  readonly failWith?: number;
}

/**
 * Stands in for Twitch's OAuth endpoint, which the IGDB gateway calls while
 * it boots, for the spec file that calls it: listening from `beforeAll`,
 * closed in `afterAll`. Every POST to the token path gets a client-credentials
 * token, or the `failWith` status when one is given; anything else is a 404,
 * so a request for the wrong path fails the gateway's boot instead of passing
 * unnoticed.
 *
 * Install it before `useGateway`, whose launch reads {@link TokenEndpoint.url}:
 * Jest runs `beforeAll` hooks in the order they are declared.
 */
export function useTokenEndpoint(options: TokenEndpointOptions = {}): TokenEndpoint {
  const received: Record<string, string>[] = [];
  let server: http.Server | undefined;
  let url: string | undefined;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const target = new URL(request.url ?? '/', 'http://token-endpoint');

      if (request.method !== 'POST' || target.pathname !== TOKEN_PATH) {
        response.writeHead(404).end();
        return;
      }

      received.push(Object.fromEntries(target.searchParams));

      if (options.failWith !== undefined) {
        response.writeHead(options.failWith).end();
        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ access_token: 'e2e-access-token', expires_in: 3600, token_type: 'bearer' }));
    });

    const listening = server;
    await new Promise<void>((resolve) => listening.listen(0, '127.0.0.1', resolve));
    const { port } = listening.address() as AddressInfo;
    url = `http://127.0.0.1:${port}${TOKEN_PATH}`;
  });

  afterAll(async () => {
    const listening = server;
    server = undefined;
    await new Promise<void>((resolve) => (listening ? listening.close(() => resolve()) : resolve()));
  });

  return {
    url: () => {
      if (url === undefined) {
        throw new Error('The token endpoint is not listening — useTokenEndpoint() starts it in beforeAll');
      }

      return url;
    },
    requests: () => received,
  };
}
