import { AuthService } from '@bge/auth';
import { Upstream } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { Http } from '@status/codes';
import type { UpstreamPrivacyPolicyDto } from '../dto/upstream-accounts-response.dto';
import { UpstreamAccountErrorCode } from '../upstream-account.constants';
import type { CreateUpstreamAccountInput } from '../upstream-account.service';
import { UpstreamAccountService } from '../upstream-account.service';
import { STEAM_RETURN_PATH, SteamLinkService } from './steam-link.service';
import type { SteamVerification } from './steam-openid';
import { SteamOpenIdVerifier } from './steam-openid';
import { OPENID_2_NAMESPACE, OPENID_IDENTIFIER_SELECT, STEAM_OPENID_ENDPOINTS } from './steam-openid.constants';
import type { PendingSteamSignIn } from './steam-sign-in.store';
import { STEAM_SIGN_IN_LIFETIME_MS, SteamSignInStore } from './steam-sign-in.store';

const ME = 'user-1';
const SOMEONE_ELSE = 'user-2';
const STEAM_ID = '76561197960287930';

/** This server's public address, with a path the realm must leave out. */
// A server behind a proxy at a sub-path: better-auth keeps the path for the
// sign-in providers' callbacks, so Steam's return keeps it too (#935).
const AUTH_URL = 'https://bge.example/games/';
const ORIGIN = 'https://bge.example';
const BASE = 'https://bge.example/games';
const RETURN_TO = 'https://app.example/settings/upstream-accounts?tab=links';
const STARTED_AT = Date.parse('2026-11-19T12:00:00.000Z');

const policy: UpstreamPrivacyPolicyDto = {
  url: '/api/privacy-policy',
  language: 'de',
  updatedAt: '2026-11-18T00:00:00.000Z',
};

/** A Steam answer's query as the return route hands it on, `state` and all. */
const answerQuery = (state: string): Record<string, unknown> => ({
  state,
  'openid.ns': OPENID_2_NAMESPACE,
  'openid.mode': 'id_res',
  'openid.claimed_id': `https://steamcommunity.com/openid/id/${STEAM_ID}`,
});

/**
 * The pending sign-ins, single use as the real store's are: taking a state
 * removes it. Each start issues a new 32-character state.
 */
class FakeSignInStore {
  readonly pending = new Map<string, PendingSteamSignIn>();
  private issued = 0;

  readonly start = jest.fn(async (input: Omit<PendingSteamSignIn, 'createdAt'>) => {
    this.issued += 1;
    const state = `state_${String(this.issued).padStart(26, '0')}`;
    this.pending.set(state, { ...input, createdAt: new Date(STARTED_AT).toISOString() });

    return { state, expiresAt: new Date(STARTED_AT + STEAM_SIGN_IN_LIFETIME_MS) };
  });

  readonly take = jest.fn(async (state: string) => {
    const found = this.pending.get(state) ?? null;
    this.pending.delete(state);

    return found;
  });
}

/** The refusal `promise` rejects with, so a test can read its status, code and body. */
async function refusal(promise: Promise<unknown>): Promise<CodedHttpException> {
  const error = await promise.then(
    () => {
      throw new Error('expected a refusal');
    },
    (reason: unknown) => reason,
  );

  expect(error).toBeInstanceOf(CodedHttpException);
  return error as CodedHttpException;
}

/** The query a redirect address carries, as an object. */
const queryOf = (address: string) => Object.fromEntries(new URL(address).searchParams);

describe('SteamLinkService (#935)', () => {
  let service: SteamLinkService;
  let store: FakeSignInStore;
  const linkDataGateway = jest.fn<Promise<{ id: string }>, [Upstream]>();
  const assertNotLinked = jest.fn<Promise<void>, [string, Upstream]>();
  const privacyPolicy = jest.fn<Promise<UpstreamPrivacyPolicyDto>, [string, string | undefined]>();
  const create = jest.fn<Promise<unknown>, [CreateUpstreamAccountInput]>();
  const verify = jest.fn<Promise<SteamVerification>, [Readonly<Record<string, unknown>>, string]>();
  const isTrustedReturnAddress = jest.fn<Promise<boolean>, [string]>();

  beforeEach(async () => {
    store = new FakeSignInStore();
    linkDataGateway.mockReset().mockResolvedValue({ id: 'dg-steam' });
    assertNotLinked.mockReset().mockResolvedValue(undefined);
    privacyPolicy.mockReset().mockResolvedValue(policy);
    create.mockReset().mockResolvedValue({});
    verify.mockReset().mockResolvedValue({ ok: true, steamId: STEAM_ID });
    isTrustedReturnAddress
      .mockReset()
      .mockImplementation(async (url) => new URL(url).origin === new URL(RETURN_TO).origin);

    const module = await Test.createTestingModule({
      providers: [
        SteamLinkService,
        { provide: ConfigService, useValue: new ConfigService({ auth: { url: AUTH_URL } }) },
        { provide: SteamSignInStore, useValue: store },
        { provide: SteamOpenIdVerifier, useValue: { verify } },
        { provide: AuthService, useValue: { isTrustedReturnAddress } },
        {
          provide: UpstreamAccountService,
          useValue: { linkDataGateway, assertNotLinked, privacyPolicy, create },
        },
      ],
    }).compile();

    service = module.get(SteamLinkService);
  });

  /** Starts a sign-in for `userId` and answers the state it was given. */
  const started = async (userId = ME, returnTo = RETURN_TO): Promise<string> => {
    await service.startSignIn(userId, returnTo, undefined);
    const [state] = [...store.pending.keys()].slice(-1);

    return state;
  };

  describe('startSignIn', () => {
    it("starts a sign-in: Steam address with this server as realm, 30-minute expiry, the policy in the user's language (#935)", async () => {
      const answer = await service.startSignIn(ME, RETURN_TO, 'de-CH, de;q=0.9');

      const [state] = [...store.pending.keys()];
      const address = new URL(answer.url);
      expect(`${address.origin}${address.pathname}`).toBe(STEAM_OPENID_ENDPOINTS.endpoint);
      expect(Object.fromEntries(address.searchParams)).toEqual({
        'openid.ns': OPENID_2_NAMESPACE,
        'openid.mode': 'checkid_setup',
        'openid.return_to': `${BASE}${STEAM_RETURN_PATH}?state=${state}`,
        'openid.realm': ORIGIN,
        'openid.identity': OPENID_IDENTIFIER_SELECT,
        'openid.claimed_id': OPENID_IDENTIFIER_SELECT,
      });
      expect(answer.expiresAt).toBe(new Date(STARTED_AT + 30 * 60 * 1000).toISOString());
      expect(answer.privacyPolicy).toEqual(policy);
      expect(privacyPolicy).toHaveBeenCalledWith(ME, 'de-CH, de;q=0.9');
      expect(store.start).toHaveBeenCalledWith({ userId: ME, returnTo: RETURN_TO });
    });

    it('keeps the return address as it was checked', async () => {
      // `new URL` lower-cases the host; the address kept is the one asked about.
      await service.startSignIn(ME, 'https://APP.example/settings', undefined);

      expect(isTrustedReturnAddress).toHaveBeenCalledWith('https://app.example/settings');
      expect(store.start).toHaveBeenCalledWith({ userId: ME, returnTo: 'https://app.example/settings' });
    });

    it('refuses a return address that is not a trusted origin', async () => {
      const error = await refusal(service.startSignIn(ME, 'https://evil.example/settings', undefined));

      expect(error.getStatus()).toBe(Http.BadRequest);
      expect(error.code).toBe(UpstreamAccountErrorCode.ReturnAddressRefused);
      expect(error.code).toBe('UPSTREAM_LINK_RETURN_ADDRESS_REFUSED');
      expect(isTrustedReturnAddress).toHaveBeenCalledWith('https://evil.example/settings');
      expect(store.start).not.toHaveBeenCalled();
    });

    // A native app's own scheme waits on #1424; a relative path or a
    // `javascript:` address is never one to send a browser to.
    it.each([
      ['a relative path', '/settings/upstream-accounts'],
      ['a protocol-relative address', '//app.example/settings'],
      ["an app's own scheme", 'bge://upstream-accounts'],
      ['a javascript: address', 'javascript:alert(1)'],
      ['no address at all', 'not an address'],
    ])('refuses %s as the return address, without asking whether it is trusted', async (_, returnTo) => {
      const error = await refusal(service.startSignIn(ME, returnTo, undefined));

      expect(error.code).toBe(UpstreamAccountErrorCode.ReturnAddressRefused);
      expect(isTrustedReturnAddress).not.toHaveBeenCalled();
      expect(store.start).not.toHaveBeenCalled();
    });

    it('refuses to start when no DataGateway declaring Steam is usable for the link', async () => {
      const notLinkable = new CodedHttpException(
        Http.Conflict,
        UpstreamAccountErrorCode.NotLinkable,
        t('errors.upstream_account.not_linkable', { upstream: Upstream.Steam }),
      );
      linkDataGateway.mockRejectedValue(notLinkable);

      await expect(service.startSignIn(ME, RETURN_TO, undefined)).rejects.toBe(notLinkable);

      expect(linkDataGateway).toHaveBeenCalledWith(Upstream.Steam);
      expect(assertNotLinked).not.toHaveBeenCalled();
      expect(store.start).not.toHaveBeenCalled();
    });

    it('refuses to start when the user already has a Steam account', async () => {
      const alreadyLinked = new CodedHttpException(
        Http.Conflict,
        UpstreamAccountErrorCode.AlreadyLinked,
        t('errors.upstream_account.already_linked', { upstream: Upstream.Steam }),
      );
      assertNotLinked.mockRejectedValue(alreadyLinked);

      await expect(service.startSignIn(ME, RETURN_TO, undefined)).rejects.toBe(alreadyLinked);
      expect(assertNotLinked).toHaveBeenCalledWith(ME, Upstream.Steam);
      expect(store.start).not.toHaveBeenCalled();
    });

    // A failed read must not replace a sign-in the user already has pending.
    it('reads the privacy policy before it starts the sign-in', async () => {
      const failure = new Error('connection reset');
      privacyPolicy.mockRejectedValue(failure);

      await expect(service.startSignIn(ME, RETURN_TO, undefined)).rejects.toBe(failure);
      expect(store.start).not.toHaveBeenCalled();
    });
  });

  describe('finishSignIn', () => {
    it('links a verified SteamID as verified, with its profile address and no display name', async () => {
      const state = await started();

      const address = await service.finishSignIn({ state, query: answerQuery(state), sessionUserId: ME });

      expect(create).toHaveBeenCalledWith({
        userId: ME,
        upstream: Upstream.Steam,
        externalId: STEAM_ID,
        profileUrl: `https://steamcommunity.com/profiles/${STEAM_ID}`,
        displayName: null,
        verified: true,
      });
      expect(address).toBe(`${RETURN_TO}&upstreamAccount=steam&result=linked`);
    });

    // `return_to` is compared by exact string equality, so the address the
    // verifier is given must be the very string the start sent Steam.
    it("verifies Steam's whole answer against the return address the start sent", async () => {
      const answer = await service.startSignIn(ME, RETURN_TO, undefined);
      const sent = new URL(answer.url).searchParams.get('openid.return_to');
      const state = new URL(String(sent)).searchParams.get('state') ?? '';
      const query = answerQuery(state);

      await service.finishSignIn({ state, query, sessionUserId: ME });

      expect(verify).toHaveBeenCalledWith(query, sent);
    });

    it('uses the state up before anything else, so a second arrival is UPSTREAM_LINK_EXPIRED', async () => {
      const order: string[] = [];
      store.take.mockImplementation(async (state) => {
        order.push('take');
        const found = store.pending.get(state) ?? null;
        store.pending.delete(state);
        return found;
      });
      verify.mockImplementation(async () => {
        order.push('verify');
        return { ok: true, steamId: STEAM_ID };
      });
      const state = await started();

      await service.finishSignIn({ state, query: answerQuery(state), sessionUserId: SOMEONE_ELSE });
      expect(order).toEqual(['take']);

      const error = await refusal(service.finishSignIn({ state, query: answerQuery(state), sessionUserId: ME }));
      expect(error.getStatus()).toBe(Http.BadRequest);
      expect(error.code).toBe(UpstreamAccountErrorCode.Expired);
      expect(error.code).toBe('UPSTREAM_LINK_EXPIRED');
      expect(error.getResponse()).toMatchObject({
        message: t('errors.upstream_account.link_expired', { upstream: Upstream.Steam, minutes: 30 }),
      });
      expect(verify).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it('answers UPSTREAM_LINK_EXPIRED for an unknown state, sending the browser nowhere', async () => {
      await started();
      const unknown = 'state_unknown_0000000000000000000';

      const error = await refusal(
        service.finishSignIn({ state: unknown, query: answerQuery(unknown), sessionUserId: ME }),
      );

      expect(error.getStatus()).toBe(Http.BadRequest);
      expect(error.code).toBe(UpstreamAccountErrorCode.Expired);
      expect(store.take).toHaveBeenCalledWith(unknown);
      expect(verify).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it('answers UPSTREAM_LINK_EXPIRED for a return with no state, taking none', async () => {
      const error = await refusal(service.finishSignIn({ state: null, query: {}, sessionUserId: ME }));

      expect(error.code).toBe(UpstreamAccountErrorCode.Expired);
      expect(store.take).not.toHaveBeenCalled();
      expect(verify).not.toHaveBeenCalled();
    });

    // The state alone could have been handed to another user, and the session
    // alone could be handed someone else's Steam answer: a link needs both,
    // naming the same user (#935).
    it.each([
      ["another user's session", SOMEONE_ELSE],
      ['no session at all', null],
    ])('refuses a return in %s, and links nothing', async (_, sessionUserId) => {
      const state = await started();

      const address = await service.finishSignIn({ state, query: answerQuery(state), sessionUserId });

      expect(queryOf(address)).toEqual({
        tab: 'links',
        upstreamAccount: 'steam',
        error: 'UPSTREAM_LINK_SESSION_MISMATCH',
      });
      expect(verify).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    });

    it('redirects with UPSTREAM_ACCOUNT_TAKEN when another user linked that SteamID', async () => {
      create.mockRejectedValue(
        new CodedHttpException(
          Http.Conflict,
          UpstreamAccountErrorCode.Taken,
          t('errors.upstream_account.taken', { upstream: Upstream.Steam }),
        ),
      );
      const state = await started();

      const address = await service.finishSignIn({ state, query: answerQuery(state), sessionUserId: ME });

      expect(queryOf(address)).toEqual({ tab: 'links', upstreamAccount: 'steam', error: 'UPSTREAM_ACCOUNT_TAKEN' });
    });

    // Starting checks first, but an account can still be linked in between.
    it('redirects with UPSTREAM_ACCOUNT_ALREADY_LINKED when the user linked a Steam account in between', async () => {
      create.mockRejectedValue(
        new CodedHttpException(
          Http.Conflict,
          UpstreamAccountErrorCode.AlreadyLinked,
          t('errors.upstream_account.already_linked', { upstream: Upstream.Steam }),
        ),
      );
      const state = await started();

      const address = await service.finishSignIn({ state, query: answerQuery(state), sessionUserId: ME });

      expect(queryOf(address)).toEqual({
        tab: 'links',
        upstreamAccount: 'steam',
        error: 'UPSTREAM_ACCOUNT_ALREADY_LINKED',
      });
    });

    // Once the state is taken the browser has somewhere to go, so a fault
    // past that point sends it back to the client with a code rather than
    // leaving it on an error answer from this server (#935).
    it.each([
      [
        'a coded refusal the return has no code of its own for',
        new CodedHttpException(
          Http.NotFound,
          UpstreamAccountErrorCode.NotFound,
          t('errors.upstream_account.not_found', { upstream: Upstream.Steam }),
        ),
      ],
      ['a database fault', new Error('connection reset')],
    ])(
      'redirects with UPSTREAM_LINK_FAILED when storing the account fails with %s, and logs it',
      async (_, failure) => {
        const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

        try {
          create.mockRejectedValue(failure);
          const state = await started();

          const address = await service.finishSignIn({ state, query: answerQuery(state), sessionUserId: ME });

          expect(queryOf(address)).toEqual({ tab: 'links', upstreamAccount: 'steam', error: 'UPSTREAM_LINK_FAILED' });
          expect(error).toHaveBeenCalledWith(expect.stringContaining(failure.message), failure.stack);
        } finally {
          error.mockRestore();
        }
      },
    );

    it('redirects with UPSTREAM_LINK_FAILED when verifying the answer throws', async () => {
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      try {
        verify.mockRejectedValue(new Error('socket hang up'));
        const state = await started();

        const address = await service.finishSignIn({ state, query: answerQuery(state), sessionUserId: ME });

        expect(queryOf(address)).toEqual({ tab: 'links', upstreamAccount: 'steam', error: 'UPSTREAM_LINK_FAILED' });
        expect(create).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
      }
    });

    it.each([
      ['cancelled', 'UPSTREAM_LINK_CANCELLED'],
      ['not-verified', 'UPSTREAM_LINK_NOT_VERIFIED'],
      ['unreachable', 'UPSTREAM_UNREACHABLE'],
    ] as const)('passes cancelled, not-verified and unreachable through as their codes: %s', async (reason, code) => {
      verify.mockResolvedValue({ ok: false, reason });
      const state = await started();

      const address = await service.finishSignIn({ state, query: answerQuery(state), sessionUserId: ME });

      expect(queryOf(address)).toEqual({ tab: 'links', upstreamAccount: 'steam', error: code });
      expect(create).not.toHaveBeenCalled();
    });

    // The address is the client's, as it gave it when starting: its own query
    // stays, and only the answer's own parameters are written (#935).
    it("writes the answer over a result or error the client's address already carried", async () => {
      const state = await started(ME, 'https://app.example/back?result=linked&error=OLD&keep=1#section');
      verify.mockResolvedValue({ ok: false, reason: 'cancelled' });

      const address = await service.finishSignIn({ state, query: answerQuery(state), sessionUserId: ME });

      const url = new URL(address);
      expect(`${url.origin}${url.pathname}`).toBe('https://app.example/back');
      expect(url.hash).toBe('#section');
      expect([...url.searchParams]).toEqual([
        ['keep', '1'],
        ['upstreamAccount', 'steam'],
        ['error', 'UPSTREAM_LINK_CANCELLED'],
      ]);
    });

    it('never puts the state, the SteamID or the return address in a warning or an error', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      // Restored in finally, so a failing expectation leaves no spy on the shared Logger prototype.
      try {
        const mismatched = await started();
        await service.finishSignIn({ state: mismatched, query: answerQuery(mismatched), sessionUserId: null });
        const refused = await started();
        verify.mockResolvedValue({ ok: false, reason: 'not-verified' });
        await service.finishSignIn({ state: refused, query: answerQuery(refused), sessionUserId: ME });
        await refusal(service.finishSignIn({ state: refused, query: answerQuery(refused), sessionUserId: ME }));
        const failed = await started();
        verify.mockResolvedValue({ ok: true, steamId: STEAM_ID });
        create.mockRejectedValue(new Error('connection reset'));
        await service.finishSignIn({ state: failed, query: answerQuery(failed), sessionUserId: ME });
        // A Prisma validation error's message and stack print the call's arguments.
        const invalid = await started();
        const validation = new Error(`Invalid create() invocation: externalId: "${STEAM_ID}"`);
        validation.name = 'PrismaClientValidationError';
        create.mockRejectedValue(validation);
        await service.finishSignIn({ state: invalid, query: answerQuery(invalid), sessionUserId: ME });

        const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls]);
        expect(warn).toHaveBeenCalled();
        expect(error).toHaveBeenCalled();
        for (const secret of [mismatched, refused, failed, invalid, STEAM_ID, RETURN_TO, 'app.example']) {
          expect(logged).not.toContain(secret);
        }
      } finally {
        warn.mockRestore();
        error.mockRestore();
      }
    });
  });
});
