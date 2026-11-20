import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { SteamOpenIdEndpoints } from '../steam-openid.constants';
import { OPENID_2_NAMESPACE } from '../steam-openid.constants';

/** A request the fake Steam received, in the order it arrived. */
export interface FakeSteamRequest {
  /** The form fields of a POST; empty for a GET. */
  readonly form: Readonly<Record<string, string>>;

  readonly method: string;

  /** The path and query asked for. */
  readonly url: string;
}

/** How the fake Steam answers. A spec may change these while it runs. */
export interface FakeSteamSwitches {
  /** `check_authentication` answers 500 instead of a verdict. Discovery still answers. */
  answer500: boolean;

  /** Every request is accepted and never answered. */
  hang: boolean;

  /** The verdict `check_authentication` gives: its `is_valid`. */
  isValid: boolean;
}

/** A stand-in for Steam's OpenID endpoints, on a loopback port (#935). */
export interface FakeSteamOpenIdServer {
  /** Its origin, with no trailing slash. */
  readonly base: string;

  /** Stops it, dropping every open connection, a hanging request's included. */
  close(): Promise<void>;

  /** Its endpoints, to give the verifier in place of Steam's. */
  readonly endpoints: SteamOpenIdEndpoints;

  /** Every request it received, in order, whether or not it answered. */
  readonly requests: readonly FakeSteamRequest[];

  readonly switches: FakeSteamSwitches;
}

const CLAIMED_ID_PATH = /^\/openid\/id\/\d+$/;

/**
 * The Yadis document Steam serves at a claimed id: one OpenID 2.0 sign-on
 * service, at its login endpoint.
 */
function xrdsFor(endpoint: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<xrds:XRDS xmlns:xrds="xri://$xrds" xmlns="xri://$xrd*($v*2.0)">',
    '<XRD>',
    '<Service priority="0">',
    '<Type>http://specs.openid.net/auth/2.0/signon</Type>',
    `<URI>${endpoint}</URI>`,
    '</Service>',
    '</XRD>',
    '</xrds:XRDS>',
  ].join('\n');
}

/**
 * Starts a fake Steam on 127.0.0.1 and a port the system picks. It answers a
 * GET of a claimed id (`/openid/id/<digits>`) with the Yadis document naming
 * its own `/openid/login`, and a POST to `/openid/login` (the
 * `check_authentication` the `openid` library sends) with the verdict its
 * switches set. It checks no signature: the verdict is the switch.
 */
export async function startFakeSteamOpenIdServer(
  switches: Partial<FakeSteamSwitches> = {},
): Promise<FakeSteamOpenIdServer> {
  const requests: FakeSteamRequest[] = [];
  const current: FakeSteamSwitches = { answer500: false, hang: false, isValid: true, ...switches };
  let base = '';

  const answer = (request: IncomingMessage, response: ServerResponse, pathname: string): void => {
    if (request.method === 'GET' && CLAIMED_ID_PATH.test(pathname)) {
      response.writeHead(200, { 'content-type': 'application/xrds+xml' });
      response.end(xrdsFor(`${base}/openid/login`));
      return;
    }

    if (request.method === 'POST' && pathname === '/openid/login') {
      if (current.answer500) {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('internal error');
        return;
      }

      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`ns:${OPENID_2_NAMESPACE}\nis_valid:${current.isValid}\n`);
      return;
    }

    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const url = request.url ?? '/';
      const body = Buffer.concat(chunks).toString('utf8');
      const form = request.method === 'POST' ? Object.fromEntries(new URLSearchParams(body)) : {};
      requests.push({ method: request.method ?? '', url, form });

      if (current.hang) {
        return;
      }

      answer(request, response, new URL(url, base).pathname);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The fake Steam server is not listening on a TCP port');
  }

  base = `http://127.0.0.1:${address.port}`;

  return {
    base,
    endpoints: { endpoint: `${base}/openid/login`, claimedIdPrefix: `${base}/openid/id/` },
    requests,
    switches: current,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // A hanging request, and the connections the library's HTTP client
        // keeps open, would hold the close (and Jest) open; this drops them.
        server.closeAllConnections();
      }),
  };
}
