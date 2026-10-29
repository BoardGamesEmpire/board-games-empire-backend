import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An OpenID Connect sign-in provider the suite controls (#912), started once by
 * `global-setup` and listed to the API child as the provider `fake`.
 *
 * It lives in this process rather than a container: there is no image to pull,
 * and each test sets the claims its sign-in returns. A test registers them
 * first (`POST /tickets`) and gets a ticket. The ticket then stands in for
 * each credential in turn: the authorization code, then the access token.
 * Nothing is signed, and the client id, client secret and PKCE verifier are
 * ignored, because what the suite proves is the API's side of the flow.
 *
 * The token response carries no ID token, so better-auth reads the claims
 * from `/userinfo`. The API reaches this address because provider requests do
 * not pass through its outbound HTTP policy yet; when they do (#982), the
 * harness must allow it.
 */
export interface FakeSignInProvider {
  /** Its origin, with no trailing slash: the issuer, and the base of every endpoint. */
  readonly url: string;

  close(): Promise<void>;
}

interface Ticket {
  readonly claims: Record<string, unknown>;
  /** The `scope` the authorization request asked for, once one has. */
  scope?: string;
}

const TICKET_PATH = /^\/tickets\/([^/]+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(chunk as Buffer);
  }

  return Buffer.concat(chunks).toString('utf8');
}

/** A token request's fields, whether it was sent as a form or as JSON. */
async function readTokenRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(request);

  if (request.headers['content-type']?.includes('application/json')) {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  }

  return Object.fromEntries(new URLSearchParams(raw));
}

/** Starts the fake on a free loopback port. */
export async function startFakeSignInProvider(): Promise<FakeSignInProvider> {
  const tickets = new Map<string, Ticket>();
  let url = '';

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestUrl = new URL(request.url ?? '/', url);
    const { pathname, searchParams } = requestUrl;

    if (request.method === 'GET' && pathname === '/.well-known/openid-configuration') {
      sendJson(response, 200, {
        issuer: url,
        authorization_endpoint: `${url}/authorize`,
        token_endpoint: `${url}/token`,
        userinfo_endpoint: `${url}/userinfo`,
      });
      return;
    }

    if (request.method === 'POST' && pathname === '/tickets') {
      const claims: unknown = JSON.parse(await readBody(request));
      if (!isRecord(claims)) {
        sendJson(response, 400, { error: 'the claims must be a JSON object' });
        return;
      }

      const ticket = randomUUID();
      tickets.set(ticket, { claims });
      sendJson(response, 201, { ticket });
      return;
    }

    const ticketPath = TICKET_PATH.exec(pathname);
    if (request.method === 'GET' && ticketPath !== null) {
      const ticket = tickets.get(decodeURIComponent(ticketPath[1]));
      if (ticket === undefined) {
        sendJson(response, 404, { error: 'unknown ticket' });
        return;
      }

      sendJson(response, 200, { scope: ticket.scope ?? null });
      return;
    }

    // The provider's consent screen, answered at once: straight back to the
    // API's callback with the ticket as the code and the API's state.
    if (request.method === 'GET' && pathname === '/authorize') {
      const code = searchParams.get('ticket') ?? '';
      const ticket = tickets.get(code);
      const redirectUri = searchParams.get('redirect_uri');
      if (ticket === undefined || redirectUri === null) {
        sendJson(response, 400, { error: 'invalid_request' });
        return;
      }

      ticket.scope = searchParams.get('scope') ?? '';

      const callback = new URL(redirectUri);
      callback.searchParams.set('code', code);
      const state = searchParams.get('state');
      if (state !== null) {
        callback.searchParams.set('state', state);
      }

      response.writeHead(302, { location: callback.toString() });
      response.end();
      return;
    }

    if (request.method === 'POST' && pathname === '/token') {
      const { code } = await readTokenRequest(request);
      if (typeof code !== 'string' || !tickets.has(code)) {
        sendJson(response, 400, { error: 'invalid_grant' });
        return;
      }

      sendJson(response, 200, { access_token: code, token_type: 'Bearer', expires_in: 3600 });
      return;
    }

    if (request.method === 'GET' && pathname === '/userinfo') {
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
      const ticket = token === undefined ? undefined : tickets.get(token);
      if (ticket === undefined) {
        sendJson(response, 401, { error: 'invalid_token' });
        return;
      }

      sendJson(response, 200, ticket.claims);
      return;
    }

    sendJson(response, 404, { error: 'not_found' });
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // The API's fetches keep their connections open; without this the
        // close would wait for them to idle out.
        server.closeAllConnections();
      }),
  };
}
