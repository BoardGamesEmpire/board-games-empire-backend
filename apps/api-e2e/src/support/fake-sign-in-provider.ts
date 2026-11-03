import { createSign, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * An OpenID Connect sign-in provider the suite controls (#912), started once by
 * `global-setup` and listed to the API child three times: as `fake`, as
 * `fake-lenient`, and as `fake-signed`.
 *
 * It lives in this process rather than a container: there is no image to pull,
 * and each test sets the claims its sign-in returns. A test registers them
 * first (`POST /tickets`) and gets a ticket. The ticket then stands in for
 * each credential in turn: the authorization code, then the access token. The
 * client secret is ignored, because what the suite proves is the API's side of
 * the flow. What the API sent is recorded on the ticket for a test to read back
 * (`GET /tickets/:ticket`): the scope, the PKCE challenge and its verifier, the
 * nonce, and how many times `/userinfo` was asked.
 *
 * The main discovery document publishes no JWKS, and its token response carries
 * no ID token, so better-auth reads the claims from `/userinfo`. The one under
 * `/signed` publishes a JWKS, so better-auth sends a nonce and takes the claims
 * from the ID token the token response then carries, signed with the key the
 * JWKS lists, once it has checked the signature, issuer, audience, expiry and
 * nonce (#1016). A test spoils that token by registering its ticket with
 * `?idToken=` and one of {@link ID_TOKEN_FAULTS}. `POST /id-tokens` signs claims as
 * they are given, for a test that submits a token the API's own flow never
 * produced.
 *
 * The API reaches this address because provider requests do not pass through
 * its outbound HTTP policy yet; when they do (#982), the harness must allow it.
 */
export interface FakeSignInProvider {
  /** Its origin, with no trailing slash: the issuer, and the base of every endpoint. */
  readonly url: string;

  close(): Promise<void>;
}

/**
 * How a ticket spoils the ID token it is sent with. Only a sign-in that sent a
 * nonce is sent one. Each fault changes one thing and keeps the rest of a sound
 * token, the published key included unless the fault is the key.
 *
 * - `forged`: every claim is right, but a key the provider doesn't publish
 *   signed it, under the published key's id.
 * - `wrong-nonce`: the provider's key signed it, but its `nonce` is not the one
 *   the sign-in sent.
 * - `wrong-audience`: its `aud` names another client, not the one the sign-in
 *   asked as (#1038).
 * - `wrong-issuer`: its `iss` is not the issuer the provider's discovery
 *   document names (#1038).
 * - `expired`: its `exp` passed two minutes ago, beyond better-auth's 30-second
 *   allowance for clock skew (#1038).
 */
export const ID_TOKEN_FAULTS = ['forged', 'wrong-nonce', 'wrong-audience', 'wrong-issuer', 'expired'] as const;

export type IdTokenFault = (typeof ID_TOKEN_FAULTS)[number];

function isIdTokenFault(value: string): value is IdTokenFault {
  return (ID_TOKEN_FAULTS as readonly string[]).includes(value);
}

/** What the API sent the provider, and asked of it, as one sign-in's ticket. */
interface Ticket {
  readonly claims: Record<string, unknown>;
  readonly idTokenFault?: IdTokenFault;
  /** The `scope` the authorization request asked for, once one has. */
  scope?: string;
  /** The `nonce` the authorization request sent, which only a provider with a JWKS is sent. */
  nonce?: string;
  /** The `client_id` the authorization request named: the ID token's audience. */
  clientId?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  /** The `code_verifier` the token request sent. */
  codeVerifier?: string;
  /** How many times `/userinfo` answered this ticket's access token. */
  userInfoCalls: number;
}

const TICKET_PATH = /^\/tickets\/([^/]+)$/;

/** Where the signed provider's discovery document is served, which makes it the provider's issuer. */
const SIGNED_PATH = '/signed';

const ID_TOKEN_LIFETIME_SECONDS = 600;

interface SigningKey {
  readonly id: string;
  readonly privateKey: KeyObject;
  /** The public half, as a JWKS lists it. */
  readonly jwk: Record<string, unknown>;
}

function generateSigningKey(id: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

  return { id, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid: id, alg: 'RS256', use: 'sig' } };
}

export const base64UrlJson = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A compact RS256 JWT. Its header names the key by id, so a verifier finds it in the JWKS. */
function signJwt(key: SigningKey, claims: Record<string, unknown>): string {
  const signingInput = `${base64UrlJson({ alg: 'RS256', typ: 'JWT', kid: key.id })}.${base64UrlJson(claims)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(key.privateKey).toString('base64url');

  return `${signingInput}.${signature}`;
}

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

/** The claims a test posted, or `undefined` once the request is answered with 400 because they are not a JSON object. */
async function readClaims(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<Record<string, unknown> | undefined> {
  const claims: unknown = JSON.parse(await readBody(request));
  if (!isRecord(claims)) {
    sendJson(response, 400, { error: 'the claims must be a JSON object' });
    return undefined;
  }

  return claims;
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

  // The first is published at `/jwks`. The second signs a forged token under the
  // first's id, so that a verifier finds the published key and fails on the
  // signature, not on a key it can't find.
  const signingKey = generateSigningKey('e2e-signing-key');
  const forgingKey = generateSigningKey(signingKey.id);

  const discoveryDocument = () => ({
    issuer: url,
    authorization_endpoint: `${url}/authorize`,
    token_endpoint: `${url}/token`,
    userinfo_endpoint: `${url}/userinfo`,
    // No `id_token_signing_alg_values_supported`, which OpenID Connect requires
    // and some providers leave out. better-auth's default stops reading `sub`
    // without it, so this proves the server keys the Account row on `sub`
    // whatever discovery says (#1016).
    // better-auth builds a provider logout URL from this, unless the
    // provider's config switches it off. It is listed so that better-auth has
    // a provider URL it could answer sign-out with. The sign-out hook and the
    // option each keep it out of the answer on their own, so the sign-out spec
    // fails only with both gone (#1016). Nothing serves it, as nothing may
    // follow it.
    end_session_endpoint: `${url}/logout`,
  });

  // OpenID Connect Discovery makes the issuer the address the document is
  // served under, and better-auth requires an ID token's `iss` to be exactly
  // what the document says (#1016).
  const signedIssuer = () => `${url}${SIGNED_PATH}`;

  const idTokenFor = (ticket: Ticket): string => {
    const issuedAt = Math.floor(Date.now() / 1000);
    const fault = ticket.idTokenFault;

    return signJwt(fault === 'forged' ? forgingKey : signingKey, {
      ...ticket.claims,
      iss: fault === 'wrong-issuer' ? `${url}/another-issuer` : signedIssuer(),
      aud: fault === 'wrong-audience' ? `${ticket.clientId}-another-client` : ticket.clientId,
      iat: fault === 'expired' ? issuedAt - 600 : issuedAt,
      exp: fault === 'expired' ? issuedAt - 120 : issuedAt + ID_TOKEN_LIFETIME_SECONDS,
      nonce: fault === 'wrong-nonce' ? `${ticket.nonce}-from-another-sign-in` : ticket.nonce,
    });
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const requestUrl = new URL(request.url ?? '/', url);
    const { pathname, searchParams } = requestUrl;

    if (request.method === 'GET' && pathname === '/.well-known/openid-configuration') {
      sendJson(response, 200, discoveryDocument());
      return;
    }

    // The same document, with the JWKS the ID tokens verify against.
    if (request.method === 'GET' && pathname === `${SIGNED_PATH}/.well-known/openid-configuration`) {
      sendJson(response, 200, {
        ...discoveryDocument(),
        issuer: signedIssuer(),
        jwks_uri: `${url}/jwks`,
        id_token_signing_alg_values_supported: ['RS256'],
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/jwks') {
      sendJson(response, 200, { keys: [signingKey.jwk] });
      return;
    }

    if (request.method === 'POST' && pathname === '/tickets') {
      const claims = await readClaims(request, response);
      if (claims === undefined) {
        return;
      }

      const fault = searchParams.get('idToken');
      if (fault !== null && !isIdTokenFault(fault)) {
        sendJson(response, 400, { error: `idToken must be one of ${ID_TOKEN_FAULTS.join(', ')}` });
        return;
      }

      const ticket = randomUUID();
      tickets.set(ticket, { claims, idTokenFault: fault ?? undefined, userInfoCalls: 0 });
      sendJson(response, 201, { ticket });
      return;
    }

    // Signs the claims exactly as given, for a test that hands the API a token
    // its own flow never produced. It adds nothing, so whatever is wrong with
    // the token, if anything, is what the test wrote.
    if (request.method === 'POST' && pathname === '/id-tokens') {
      const claims = await readClaims(request, response);
      if (claims === undefined) {
        return;
      }

      sendJson(response, 201, { idToken: signJwt(signingKey, claims) });
      return;
    }

    const ticketPath = TICKET_PATH.exec(pathname);
    if (request.method === 'GET' && ticketPath !== null) {
      const ticket = tickets.get(decodeURIComponent(ticketPath[1]));
      if (ticket === undefined) {
        sendJson(response, 404, { error: 'unknown ticket' });
        return;
      }

      sendJson(response, 200, {
        scope: ticket.scope ?? null,
        nonce: ticket.nonce ?? null,
        codeChallenge: ticket.codeChallenge ?? null,
        codeChallengeMethod: ticket.codeChallengeMethod ?? null,
        codeVerifier: ticket.codeVerifier ?? null,
        userInfoCalls: ticket.userInfoCalls,
      });
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
      ticket.nonce = searchParams.get('nonce') ?? undefined;
      ticket.clientId = searchParams.get('client_id') ?? undefined;
      ticket.codeChallenge = searchParams.get('code_challenge') ?? undefined;
      ticket.codeChallengeMethod = searchParams.get('code_challenge_method') ?? undefined;

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
      const { code, code_verifier: codeVerifier } = await readTokenRequest(request);
      const ticket = typeof code === 'string' ? tickets.get(code) : undefined;
      if (typeof code !== 'string' || ticket === undefined) {
        sendJson(response, 400, { error: 'invalid_grant' });
        return;
      }

      ticket.codeVerifier = typeof codeVerifier === 'string' ? codeVerifier : undefined;

      // An ID token goes only to a sign-in that sent a nonce, and better-auth
      // sends one only to a provider whose discovery document has a JWKS.
      sendJson(response, 200, {
        access_token: code,
        token_type: 'Bearer',
        expires_in: 3600,
        ...(ticket.nonce === undefined ? {} : { id_token: idTokenFor(ticket) }),
      });
      return;
    }

    if (request.method === 'GET' && pathname === '/userinfo') {
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
      const ticket = token === undefined ? undefined : tickets.get(token);
      if (ticket === undefined) {
        sendJson(response, 401, { error: 'invalid_token' });
        return;
      }

      ticket.userInfoCalls += 1;
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
