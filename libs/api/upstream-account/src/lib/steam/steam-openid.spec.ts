import { Logger } from '@nestjs/common';
import { RelyingParty } from 'openid';
import type { SteamVerification } from './steam-openid';
import { SteamOpenIdVerifier, steamSignInUrl } from './steam-openid';
import type { FakeSteamOpenIdServer } from './testing/fake-steam-openid-server';
import { startFakeSteamOpenIdServer } from './testing/fake-steam-openid-server';

const OPENID_NS = 'http://specs.openid.net/auth/2.0';
const IDENTIFIER_SELECT = 'http://specs.openid.net/auth/2.0/identifier_select';
const STEAM_ID = '76561197960287930';
const STATE = 'pending-sign-in-state';
const APP = 'https://games.example.test';
const RETURN_PATH = '/api/users/me/upstream-accounts/steam/return';
const RETURN_URL = `${APP}${RETURN_PATH}?state=${STATE}`;

/** The library's own method, kept before any spec wraps it. */
const libraryVerifyAssertion = RelyingParty.prototype.verifyAssertion;

const CANCELLED: SteamVerification = { ok: false, reason: 'cancelled' };
const NOT_VERIFIED: SteamVerification = { ok: false, reason: 'not-verified' };
const UNREACHABLE: SteamVerification = { ok: false, reason: 'unreachable' };

type Query = Record<string, unknown>;

let nonceCount = 0;

/**
 * A response nonce as Steam sends one: the current UTC time to the second,
 * then a tail unique to the answer. The library refuses a nonce more than five
 * minutes off, or one it has already seen in this process.
 */
function freshNonce(): string {
  nonceCount += 1;

  return `${new Date().toISOString().slice(0, 19)}Z${nonceCount}${Math.random().toString(36).slice(2)}`;
}

/**
 * The query a positive Steam answer brings to the return route: the sign-in's
 * own `state`, then the fields Steam sends, signed as Steam signs them.
 */
function steamAnswer(steam: FakeSteamOpenIdServer, overrides: Query = {}): Query {
  const claimedId = `${steam.endpoints.claimedIdPrefix}${STEAM_ID}`;

  return {
    state: STATE,
    'openid.ns': OPENID_NS,
    'openid.mode': 'id_res',
    'openid.op_endpoint': steam.endpoints.endpoint,
    'openid.claimed_id': claimedId,
    'openid.identity': claimedId,
    'openid.return_to': RETURN_URL,
    'openid.response_nonce': freshNonce(),
    'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle',
    'openid.sig': 'W0u5DRbtHE1GG0ZKXjerUZDUGmc=',
    ...overrides,
  };
}

/** The query without one key. */
function without(query: Query, key: string): Query {
  return Object.fromEntries(Object.entries(query).filter(([name]) => name !== key));
}

/** The answer as the request address the library reads it from. */
function addressOf(query: Query): string {
  const url = new URL(`${APP}${RETURN_PATH}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.append(key, String(value));
  }

  return url.toString();
}

/** What the `openid` library makes of an answer on its own, with the settings the verifier gives it. */
function libraryAlone(query: Query): Promise<{ authenticated: boolean | undefined; error: string | undefined }> {
  return new Promise((resolve) => {
    new RelyingParty(RETURN_URL, APP, true, true, []).verifyAssertion(addressOf(query), (error, result) =>
      resolve({ authenticated: result?.authenticated, error: error?.message }),
    );
  });
}

describe('steamSignInUrl', () => {
  it('builds a checkid_setup address with identifier_select, the return address and the realm (#935)', () => {
    const address = new URL(steamSignInUrl(RETURN_URL, APP));

    expect(`${address.origin}${address.pathname}`).toBe('https://steamcommunity.com/openid/login');
    expect([...address.searchParams]).toEqual([
      ['openid.ns', OPENID_NS],
      ['openid.mode', 'checkid_setup'],
      ['openid.return_to', RETURN_URL],
      ['openid.realm', APP],
      ['openid.identity', IDENTIFIER_SELECT],
      ['openid.claimed_id', IDENTIFIER_SELECT],
    ]);
  });

  it('sends the sign-in to the endpoint it is given', () => {
    const address = new URL(
      steamSignInUrl(RETURN_URL, APP, {
        endpoint: 'http://127.0.0.1:9/openid/login',
        claimedIdPrefix: 'http://127.0.0.1:9/openid/id/',
      }),
    );

    expect(`${address.origin}${address.pathname}`).toBe('http://127.0.0.1:9/openid/login');
    expect(address.searchParams.get('openid.return_to')).toBe(RETURN_URL);
  });
});

/**
 * Against the real `openid` library and a fake Steam over loopback sockets
 * (#935). A stub library would not show which addresses the library contacts,
 * and that is what the checks before it are for.
 */
describe('SteamOpenIdVerifier', () => {
  const running: FakeSteamOpenIdServer[] = [];
  let steam: FakeSteamOpenIdServer;
  let libraryVerify: jest.SpyInstance;
  let warn: jest.SpyInstance;

  async function startSteam(): Promise<FakeSteamOpenIdServer> {
    const server = await startFakeSteamOpenIdServer();
    running.push(server);

    return server;
  }

  function verifierFor(server: FakeSteamOpenIdServer, timeoutMs = 2_000): SteamOpenIdVerifier {
    return new SteamOpenIdVerifier(server.endpoints, timeoutMs);
  }

  beforeEach(async () => {
    steam = await startSteam();
    libraryVerify = jest.spyOn(RelyingParty.prototype, 'verifyAssertion');
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(running.splice(0).map((server) => server.close()));
  });

  /** A refusal made before the library runs: nothing reaches Steam, or any other host. */
  function expectNoRequest(...servers: FakeSteamOpenIdServer[]): void {
    expect(libraryVerify).not.toHaveBeenCalled();
    for (const server of servers) {
      expect(server.requests).toEqual([]);
    }
  }

  it('verifies a signed answer and returns the SteamID from the claimed id', async () => {
    const answer = steamAnswer(steam);

    await expect(verifierFor(steam).verify(answer, RETURN_URL)).resolves.toEqual({ ok: true, steamId: STEAM_ID });

    // The library discovers the claimed id, then asks the answer's op_endpoint
    // to check the signature. The check carries the answer's OpenID fields, and
    // not the sign-in's own state.
    expect(steam.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
      `GET /openid/id/${STEAM_ID}`,
      'POST /openid/login',
    ]);
    expect(steam.requests[1].form).toEqual({
      ...without(without(answer, 'state'), 'openid.mode'),
      'openid.mode': 'check_authentication',
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers not-verified when Steam says is_valid:false', async () => {
    steam.switches.isValid = false;

    await expect(verifierFor(steam).verify(steamAnswer(steam), RETURN_URL)).resolves.toEqual(NOT_VERIFIED);
    expect(steam.requests.map(({ method }) => method)).toEqual(['GET', 'POST']);
  });

  it('answers cancelled for openid.mode=cancel, with no request', async () => {
    const cancel = { state: STATE, 'openid.ns': OPENID_NS, 'openid.mode': 'cancel' };

    await expect(verifierFor(steam).verify(cancel, RETURN_URL)).resolves.toEqual(CANCELLED);
    expectNoRequest(steam);
  });

  describe('an answer that names another host', () => {
    // `elsewhere` is shaped like Steam and vouches for every answer. The
    // library contacts whatever the answer names, so without the checks before
    // it, `elsewhere` would be asked, and would vouch for a forged answer.
    let elsewhere: FakeSteamOpenIdServer;

    beforeEach(async () => {
      elsewhere = await startSteam();
    });

    const cases: [string, (steam: FakeSteamOpenIdServer, elsewhere: FakeSteamOpenIdServer) => Query][] = [
      ['op_endpoint on another host', (_steam, other) => ({ 'openid.op_endpoint': other.endpoints.endpoint })],
      [
        'claimed id and identity on another host',
        (_steam, other) => ({
          'openid.claimed_id': `${other.endpoints.claimedIdPrefix}${STEAM_ID}`,
          'openid.identity': `${other.endpoints.claimedIdPrefix}${STEAM_ID}`,
        }),
      ],
      [
        'op_endpoint, claimed id and identity all on another host',
        (_steam, other) => ({
          'openid.op_endpoint': other.endpoints.endpoint,
          'openid.claimed_id': `${other.endpoints.claimedIdPrefix}${STEAM_ID}`,
          'openid.identity': `${other.endpoints.claimedIdPrefix}${STEAM_ID}`,
        }),
      ],
    ];

    it.each(cases)(
      "refuses an op_endpoint or claimed id that isn't Steam's without a request: %s",
      async (_case, forge) => {
        const answer = steamAnswer(steam, forge(steam, elsewhere));

        await expect(verifierFor(steam).verify(answer, RETURN_URL)).resolves.toEqual(NOT_VERIFIED);
        expectNoRequest(steam, elsewhere);
      },
    );

    it('is accepted by the library alone, which is why the checks come first (control)', async () => {
      const forged = steamAnswer(steam, cases[2][1](steam, elsewhere));

      await expect(libraryAlone(forged)).resolves.toEqual({ authenticated: true, error: undefined });
      expect(elsewhere.requests.map(({ method }) => method)).toEqual(['GET', 'POST']);
      expect(steam.requests).toEqual([]);
    });
  });

  it.each<[string, (steam: FakeSteamOpenIdServer) => Query]>([
    [
      'an identity that differs from the claimed id',
      (server) => ({ 'openid.identity': `${server.endpoints.claimedIdPrefix}76561197960287931` }),
    ],
    [
      'a SteamID of 16 digits',
      (server) => ({
        'openid.claimed_id': `${server.endpoints.claimedIdPrefix}7656119796028793`,
        'openid.identity': `${server.endpoints.claimedIdPrefix}7656119796028793`,
      }),
    ],
    [
      'a SteamID of 18 digits',
      (server) => ({
        'openid.claimed_id': `${server.endpoints.claimedIdPrefix}765611979602879300`,
        'openid.identity': `${server.endpoints.claimedIdPrefix}765611979602879300`,
      }),
    ],
    [
      'a fragment after the SteamID',
      (server) => ({
        'openid.claimed_id': `${server.endpoints.claimedIdPrefix}${STEAM_ID}#me`,
        'openid.identity': `${server.endpoints.claimedIdPrefix}${STEAM_ID}#me`,
      }),
    ],
    [
      'a path after the SteamID',
      (server) => ({
        'openid.claimed_id': `${server.endpoints.claimedIdPrefix}${STEAM_ID}/`,
        'openid.identity': `${server.endpoints.claimedIdPrefix}${STEAM_ID}/`,
      }),
    ],
  ])('refuses a claimed id not of the form Steam answers with, without a request: %s', async (_case, forge) => {
    await expect(verifierFor(steam).verify(steamAnswer(steam, forge(steam)), RETURN_URL)).resolves.toEqual(
      NOT_VERIFIED,
    );
    expectNoRequest(steam);
  });

  it.each([
    ['another state', `${APP}${RETURN_PATH}?state=another-state`],
    // The library's own check passes this one: it compares only the parameters
    // the answer's return_to carries.
    ['no state', `${APP}${RETURN_PATH}`],
    ['an extra parameter', `${RETURN_URL}&extra=1`],
    ['another host', `https://elsewhere.example.test${RETURN_PATH}?state=${STATE}`],
    ['another path', `${APP}/api/other?state=${STATE}`],
  ])('refuses a return_to that is not the address this sign-in sent: %s', async (_case, returnTo) => {
    const answer = steamAnswer(steam, { 'openid.return_to': returnTo });

    await expect(verifierFor(steam).verify(answer, RETURN_URL)).resolves.toEqual(NOT_VERIFIED);
    expectNoRequest(steam);
  });

  it('accepts a return_to without the state when the library checks it alone (control)', async () => {
    const answer = steamAnswer(steam, { 'openid.return_to': `${APP}${RETURN_PATH}` });

    await expect(libraryAlone(answer)).resolves.toEqual({ authenticated: true, error: undefined });
  });

  it.each<[string, (steam: FakeSteamOpenIdServer) => Query]>([
    [
      'the claimed id given twice',
      (server) => ({
        'openid.claimed_id': [
          `${server.endpoints.claimedIdPrefix}${STEAM_ID}`,
          `${server.endpoints.claimedIdPrefix}${STEAM_ID}`,
        ],
      }),
    ],
    ['the state given twice', () => ({ state: [STATE, STATE] })],
    ['a nested value', () => ({ 'openid.ext': { alias: 'value' } })],
  ])('refuses a repeated query value: %s', async (_case, forge) => {
    await expect(verifierFor(steam).verify(steamAnswer(steam, forge(steam)), RETURN_URL)).resolves.toEqual(
      NOT_VERIFIED,
    );
    expectNoRequest(steam);
  });

  it.each<[string, (answer: Query) => Query]>([
    ['no openid.mode', (answer) => without(answer, 'openid.mode')],
    ['openid.mode=error', (answer) => ({ ...answer, 'openid.mode': 'error', 'openid.error': 'Steam failed' })],
    ['openid.mode=setup_needed', (answer) => ({ ...answer, 'openid.mode': 'setup_needed' })],
    ['no openid.ns, as OpenID 1.1 sends', (answer) => without(answer, 'openid.ns')],
    ['an OpenID 1.1 namespace', (answer) => ({ ...answer, 'openid.ns': 'http://openid.net/signon/1.1' })],
  ])('refuses an answer that is not an OpenID 2.0 positive assertion, without a request: %s', async (_case, change) => {
    await expect(verifierFor(steam).verify(change(steamAnswer(steam)), RETURN_URL)).resolves.toEqual(NOT_VERIFIED);
    expectNoRequest(steam);
  });

  // The fake vouches for any answer, as the library alone would let it: the
  // library checks no list of signed fields, and asks about the signature only
  // after discovering the claimed id.
  it.each<[string, (answer: Query) => Query]>([
    [
      'claimed_id left out of openid.signed',
      (answer) => ({ ...answer, 'openid.signed': 'signed,op_endpoint,identity,return_to,response_nonce,assoc_handle' }),
    ],
    [
      'return_to left out of openid.signed',
      (answer) => ({
        ...answer,
        'openid.signed': 'signed,op_endpoint,claimed_id,identity,response_nonce,assoc_handle',
      }),
    ],
    [
      'op_endpoint left out of openid.signed',
      (answer) => ({ ...answer, 'openid.signed': 'signed,claimed_id,identity,return_to,response_nonce,assoc_handle' }),
    ],
    ['no openid.signed', (answer) => without(answer, 'openid.signed')],
    ['no openid.sig', (answer) => without(answer, 'openid.sig')],
  ])(
    'refuses an answer whose signature does not cover the fields it must, without a request: %s',
    async (_case, change) => {
      await expect(verifierFor(steam).verify(change(steamAnswer(steam)), RETURN_URL)).resolves.toEqual(NOT_VERIFIED);
      expectNoRequest(steam);
    },
  );

  it('accepts an answer whose signature leaves out the claimed id when the library checks it alone (control)', async () => {
    const answer = steamAnswer(steam, {
      'openid.signed': 'signed,op_endpoint,identity,return_to,response_nonce,assoc_handle',
    });

    await expect(libraryAlone(answer)).resolves.toEqual({ authenticated: true, error: undefined });
  });

  it('refuses a replayed answer without asking Steam again', async () => {
    const answer = steamAnswer(steam);
    const verifier = verifierFor(steam);

    await expect(verifier.verify(answer, RETURN_URL)).resolves.toEqual({ ok: true, steamId: STEAM_ID });
    await expect(verifier.verify(answer, RETURN_URL)).resolves.toEqual(NOT_VERIFIED);
    expect(steam.requests).toHaveLength(2);
  });

  it('refuses an answer whose nonce is more than five minutes old, without a request', async () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString().slice(0, 19);
    const answer = steamAnswer(steam, { 'openid.response_nonce': `${tenMinutesAgo}Zstale` });

    await expect(verifierFor(steam).verify(answer, RETURN_URL)).resolves.toEqual(NOT_VERIFIED);
    expect(steam.requests).toEqual([]);
  });

  it('times out as unreachable', async () => {
    steam.switches.hang = true;
    // The verifier settles on the timeout, but the library's own request is
    // still held; its callback fires when the connection drops.
    const libraryFinished = new Promise<void>((resolve) => {
      libraryVerify.mockImplementation(function (
        this: RelyingParty,
        requestOrUrl: string,
        callback: Parameters<RelyingParty['verifyAssertion']>[1],
      ) {
        libraryVerifyAssertion.call(this, requestOrUrl, (error, result) => {
          callback(error, result);
          resolve();
        });
      });
    });

    await expect(verifierFor(steam, 200).verify(steamAnswer(steam), RETURN_URL)).resolves.toEqual(UNREACHABLE);
    // Discovery asked and got no answer: the timeout, not a refusal, ended it.
    expect(steam.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([`GET /openid/id/${STEAM_ID}`]);
    expect(warn).toHaveBeenCalledTimes(1);

    // Close the fake here and wait for the library to finish, so no request of
    // its reaches a later spec's server on a reused port (#935).
    running.splice(running.indexOf(steam), 1);
    await steam.close();
    await libraryFinished;
  });

  it('answers unreachable when Steam refuses the connection', async () => {
    const gone = await startFakeSteamOpenIdServer();
    await gone.close();

    await expect(verifierFor(gone).verify(steamAnswer(gone), RETURN_URL)).resolves.toEqual(UNREACHABLE);
  });

  it('settles once when the library calls back twice', async () => {
    // An answer of 500 from check_authentication reaches the library's callback
    // twice: once with the answer, once with the error axios raises for it
    // (openid's http.js).
    steam.switches.answer500 = true;
    const callbacks: unknown[] = [];
    libraryVerify.mockImplementation(function (
      this: RelyingParty,
      requestOrUrl: string,
      callback: Parameters<RelyingParty['verifyAssertion']>[1],
    ) {
      libraryVerifyAssertion.call(this, requestOrUrl, (error, result) => {
        callbacks.push(error);
        callback(error, result);
      });
    });

    await expect(verifierFor(steam).verify(steamAnswer(steam), RETURN_URL)).resolves.toEqual(UNREACHABLE);
    expect(callbacks).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('answers not-verified when the library confirms a claimed id other than the one checked', async () => {
    libraryVerify.mockImplementation((_requestOrUrl, callback: Parameters<RelyingParty['verifyAssertion']>[1]) =>
      callback(null, { authenticated: true, claimedIdentifier: `${steam.endpoints.claimedIdPrefix}76561197960287931` }),
    );

    await expect(verifierFor(steam).verify(steamAnswer(steam), RETURN_URL)).resolves.toEqual(NOT_VERIFIED);
  });

  it('answers not-verified when the library throws', async () => {
    libraryVerify.mockImplementation(() => {
      throw new TypeError('malformed');
    });

    await expect(verifierFor(steam).verify(steamAnswer(steam), RETURN_URL)).resolves.toEqual(NOT_VERIFIED);
  });
});
