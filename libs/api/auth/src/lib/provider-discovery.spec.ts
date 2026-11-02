import type { PrismaClient } from '@bge/database';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Keyv from 'keyv';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { authFactory } from './auth-factory';
import { memoryAuthStorage } from './memory-auth-storage.fixture';

const SECRET = 'a-unit-test-secret-of-at-least-32-characters';
const API_ORIGIN = 'http://localhost:33333';

/** A database where every lookup finds nothing. */
const noUsers = new Proxy(
  {},
  { get: () => new Proxy({}, { get: (_model, operation) => async () => (operation === 'findMany' ? [] : null) }) },
) as PrismaClient;

/** A sign-in provider's discovery endpoint, answering over a real loopback socket. */
interface FakeProvider {
  /** Its origin, with no trailing slash: the issuer. */
  readonly url: string;
  /** What its discovery document gives as the authorization endpoint. */
  readonly authorizationEndpoint: string;
  close(): Promise<void>;
}

/**
 * An address on the loopback interface nothing listens on: a port is taken from
 * the system and given back. A connection to it is refused at once, which is
 * how a provider that is down answers.
 */
async function reservePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));

  return port;
}

/**
 * Starts a provider on `port`. Its discovery document holds what better-auth
 * needs to count it as OpenID Connect: the issuer, the three endpoints, and
 * the signing algorithms.
 */
async function startProvider(port: number): Promise<FakeProvider> {
  const url = `http://127.0.0.1:${port}`;
  const authorizationEndpoint = `${url}/authorize`;

  const server: Server = createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/.well-known/openid-configuration') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          issuer: url,
          authorization_endpoint: authorizationEndpoint,
          token_endpoint: `${url}/token`,
          userinfo_endpoint: `${url}/userinfo`,
          id_token_signing_alg_values_supported: ['RS256'],
        }),
      );
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    url,
    authorizationEndpoint,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        // better-auth's fetches keep their connections open; without this the
        // close would wait for them to idle out.
        server.closeAllConnections();
      }),
  };
}

/**
 * A sign-in provider that was down when the api started, then came back, or
 * never did (#1016). better-auth skips a provider whose discovery fails at
 * startup and fetches it again when a request names it, so the server needs no
 * restart. These go through a real instance's handler and real sockets: a stub
 * `fetch` would not show whether the retry reaches the provider.
 *
 * A provider that accepts a connection and never answers is a different
 * failure (#1023): it holds startup, and the requests behind it, until the
 * connection gives up. Nothing here covers it.
 */
describe("authFactory's sign-in provider discovery", () => {
  const running: FakeProvider[] = [];

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(running.splice(0).map((provider) => provider.close()));
  });

  async function start(port: number): Promise<FakeProvider> {
    const provider = await startProvider(port);
    running.push(provider);

    return provider;
  }

  function authFor(port: number) {
    const config = new ConfigService({
      auth: {
        url: API_ORIGIN,
        secret: SECRET,
        trustedOrigins: [],
        useEmailPasswordAuth: true,
        oidcProviders: [
          {
            id: 'fake',
            discoveryUrl: `http://127.0.0.1:${port}/.well-known/openid-configuration`,
            clientId: 'c',
            clientSecret: 's',
            displayName: 'Fake',
            allowUnverifiedEmail: false,
          },
        ],
      },
    });

    return authFactory(noUsers, config, memoryAuthStorage(new Keyv({ throwOnErrors: true })));
  }

  const signInWithFake = (auth: ReturnType<typeof authFor>) =>
    auth.handler(
      new Request(`${API_ORIGIN}/api/auth/sign-in/social`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: API_ORIGIN },
        body: JSON.stringify({ provider: 'fake', callbackURL: `${API_ORIGIN}/` }),
      }),
    );

  /**
   * A refused discovery is logged as an error when the instance is built and
   * again on each retry, which is what an operator reads to learn why a provider
   * is missing. The specs keep them out of the test output.
   */
  const silenceDiscoveryErrors = () => jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

  it('signs in once a provider that was down at startup is back, without a restart (#1016)', async () => {
    const logged = silenceDiscoveryErrors();
    const port = await reservePort();
    const auth = authFor(port);
    await auth.$context;

    const whileDown = await signInWithFake(auth);

    expect(whileDown.status).toBe(404);
    await expect(whileDown.json()).resolves.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    // The operator can see why: the failure is logged against the provider.
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ msg: expect.stringContaining('"fake"') }));

    // The same instance, with nothing rebuilt: the provider comes up on the address.
    const provider = await start(port);
    const afterUp = await signInWithFake(auth);

    expect(afterUp.status).toBe(200);
    const { url } = (await afterUp.json()) as { url: string };
    const redirect = new URL(url);
    expect(`${redirect.origin}${redirect.pathname}`).toBe(provider.authorizationEndpoint);
    expect(redirect.searchParams.get('client_id')).toBe('c');
  });

  it('keeps answering PROVIDER_NOT_FOUND while the provider stays down (#1016)', async () => {
    silenceDiscoveryErrors();
    const auth = authFor(await reservePort());
    await auth.$context;

    // Each request retries and fails again; a failed retry must not turn into
    // a different answer, or stop the next request from trying.
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await signInWithFake(auth);

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({ code: 'PROVIDER_NOT_FOUND' });
    }
  });
});
