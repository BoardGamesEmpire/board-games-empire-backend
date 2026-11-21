import { GatewayCoordinatorClientService } from '@bge/coordinator';
import type { UpstreamAccount } from '@bge/database';
import { Upstream } from '@bge/database';
import { CodedHttpException, t } from '@bge/i18n';
import type {
  CoordinatorFindUpstreamAccountRequest,
  CoordinatorFindUpstreamAccountResponse,
} from '@boardgamesempire/proto-gateway';
import { ResultStatus } from '@boardgamesempire/proto-gateway';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Http } from '@status/codes';
import { EMPTY, Observable, of, throwError } from 'rxjs';
import { UpstreamAccountErrorCode } from '../upstream-account.constants';
import type { CreateUpstreamAccountInput } from '../upstream-account.service';
import { UpstreamAccountService } from '../upstream-account.service';
import { UpstreamThrottledException } from '../upstream-throttled.exception';
import { BGG_LOOKUP_TIMEOUT_MS, BggLinkService } from './bgg-link.service';

const ME = 'user-1';
const SOMEONE_ELSE = 'user-2';
const GATEWAY_ID = 'dg-bgg';

/** As the user typed it; BoardGameGeek keeps it as `BGFan`. */
const TYPED = 'bgfan';
const BGG_NAME = 'BGFan';
const BGG_PROFILE = 'https://boardgamegeek.com/user/BGFan';

const found = (
  overrides: Partial<CoordinatorFindUpstreamAccountResponse> = {},
): CoordinatorFindUpstreamAccountResponse => ({
  correlationId: 'corr',
  gatewayId: GATEWAY_ID,
  status: ResultStatus.RESULT_STATUS_RESULT,
  account: { externalId: BGG_NAME, displayName: BGG_NAME, profileUrl: BGG_PROFILE },
  ...overrides,
});

const answer = (
  status: ResultStatus,
  overrides: Partial<CoordinatorFindUpstreamAccountResponse> = {},
): CoordinatorFindUpstreamAccountResponse => ({ correlationId: 'corr', gatewayId: GATEWAY_ID, status, ...overrides });

/** The row `create` stores for `input`. */
const rowFor = (input: CreateUpstreamAccountInput): UpstreamAccount => ({
  id: `ua-${input.userId}`,
  userId: input.userId,
  upstream: input.upstream,
  externalId: input.externalId,
  displayName: input.displayName ?? null,
  profileUrl: input.profileUrl ?? null,
  verified: input.verified,
  createdAt: new Date('2026-11-19T10:00:00.000Z'),
  updatedAt: new Date('2026-11-19T10:00:00.000Z'),
});

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

describe('BggLinkService (#1226)', () => {
  let service: BggLinkService;
  const linkDataGateway = jest.fn<Promise<{ id: string } | null>, [Upstream]>();
  const assertNotLinked = jest.fn<Promise<void>, [string, Upstream]>();
  const create = jest.fn<Promise<UpstreamAccount>, [CreateUpstreamAccountInput]>();
  const findUpstreamAccount = jest.fn<
    Observable<CoordinatorFindUpstreamAccountResponse>,
    [CoordinatorFindUpstreamAccountRequest]
  >();
  let logged: string[];

  beforeEach(async () => {
    linkDataGateway.mockReset().mockResolvedValue({ id: GATEWAY_ID });
    assertNotLinked.mockReset().mockResolvedValue(undefined);
    create.mockReset().mockImplementation(async (input) => rowFor(input));
    findUpstreamAccount.mockReset().mockReturnValue(of(found()));

    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      });
    }

    const module = await Test.createTestingModule({
      providers: [
        BggLinkService,
        { provide: UpstreamAccountService, useValue: { linkDataGateway, assertNotLinked, create } },
        { provide: GatewayCoordinatorClientService, useValue: { findUpstreamAccount } },
      ],
    }).compile();

    service = module.get(BggLinkService);
    logged = [];
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('looks the username up through the usable DataGateway and stores the account unverified, as BoardGameGeek writes it', async () => {
    const account = await service.link(ME, TYPED);

    expect(linkDataGateway).toHaveBeenCalledWith(Upstream.BoardGameGeek);
    expect(findUpstreamAccount).toHaveBeenCalledWith({
      correlationId: expect.any(String),
      gatewayId: GATEWAY_ID,
      username: TYPED,
    });
    // Only the key the request names: no external id beside the username.
    expect(findUpstreamAccount.mock.calls[0][0]).not.toHaveProperty('externalId');
    // A typed username proves nothing, so the account is a claim, never
    // verified (#1226). The external id is BoardGameGeek's own spelling, and
    // the display name the name BoardGameGeek shows.
    expect(create).toHaveBeenCalledWith({
      userId: ME,
      upstream: Upstream.BoardGameGeek,
      externalId: BGG_NAME,
      displayName: BGG_NAME,
      profileUrl: BGG_PROFILE,
      verified: false,
    });
    expect(account).toMatchObject({ externalId: BGG_NAME, verified: false, profileUrl: BGG_PROFILE });
  });

  // Refusing the second user would let anyone take another person's username
  // first; telling either would reveal the other's link (#1226).
  it('lets a second user link the same username, and neither answer nor log mentions the other', async () => {
    const first = await service.link(ME, TYPED);
    const second = await service.link(SOMEONE_ELSE, TYPED);

    // The same lookup and the same store for each: the second link is an
    // ordinary one, and nothing first checks who else has the username.
    expect(create.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ userId: ME, externalId: BGG_NAME, verified: false }),
      expect.objectContaining({ userId: SOMEONE_ELSE, externalId: BGG_NAME, verified: false }),
    ]);
    expect(JSON.stringify(first)).not.toContain(SOMEONE_ELSE);
    expect(JSON.stringify(second)).not.toContain(ME);
    expect(logged).toEqual([]);
  });

  it('keeps the username out of every log line, whatever the answer', async () => {
    findUpstreamAccount.mockReturnValueOnce(of(answer(ResultStatus.RESULT_STATUS_ERROR, { message: 'boom' })));
    await refusal(service.link(ME, TYPED));
    findUpstreamAccount.mockReturnValueOnce(of(answer(ResultStatus.RESULT_STATUS_RATE_LIMITED, { retryAfterMs: 5 })));
    await refusal(service.link(ME, TYPED));
    findUpstreamAccount.mockReturnValueOnce(throwError(() => new Error('14 UNAVAILABLE: No connection established')));
    await refusal(service.link(ME, TYPED));

    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join('\n').toLowerCase()).not.toContain(TYPED);
  });

  it('answers 404 UPSTREAM_ACCOUNT_UNKNOWN_USERNAME when BoardGameGeek has no user by that name, and stores nothing', async () => {
    findUpstreamAccount.mockReturnValue(of(answer(ResultStatus.RESULT_STATUS_NOT_FOUND)));

    const error = await refusal(service.link(ME, TYPED));

    expect(error.getStatus()).toBe(Http.NotFound);
    expect(error.code).toBe(UpstreamAccountErrorCode.UnknownUsername);
    expect(error.code).toBe('UPSTREAM_ACCOUNT_UNKNOWN_USERNAME');
    expect(error.getResponse()).toMatchObject({
      message: t('errors.upstream_account.unknown_username', { upstream: Upstream.BoardGameGeek }),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('answers 503 UPSTREAM_THROTTLED with the wait the DataGateway gave, as retryAfterMs', async () => {
    findUpstreamAccount.mockReturnValue(of(answer(ResultStatus.RESULT_STATUS_RATE_LIMITED, { retryAfterMs: 12_500 })));

    const error = await refusal(service.link(ME, TYPED));

    expect(error.getStatus()).toBe(Http.ServiceUnavailable);
    expect(error.code).toBe('UPSTREAM_THROTTLED');
    expect(error.getResponse()).toMatchObject({
      code: 'UPSTREAM_THROTTLED',
      retryAfterMs: 12_500,
      message: t('errors.upstream_account.throttled', { upstream: Upstream.BoardGameGeek, seconds: 13 }),
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('carries the wait in whole seconds, for the route to send as Retry-After', async () => {
    findUpstreamAccount.mockReturnValue(of(answer(ResultStatus.RESULT_STATUS_RATE_LIMITED, { retryAfterMs: 12_500 })));

    const error = await refusal(service.link(ME, TYPED));

    expect(error).toBeInstanceOf(UpstreamThrottledException);
    expect((error as UpstreamThrottledException).retryAfterSeconds).toBe(13);
  });

  // A wait that is missing, zero or negative is no wait at all, read as every
  // consumer of a DataGateway's wait reads it (#925): telling the user to try
  // again in 0 seconds would send them straight back into the throttle.
  it.each([
    ['gives no wait', undefined],
    ['gives a wait of zero', 0],
    ['gives a negative wait', -5_000],
  ])('answers a minute as retryAfterMs when a throttled answer %s', async (_name, retryAfterMs) => {
    findUpstreamAccount.mockReturnValue(of(answer(ResultStatus.RESULT_STATUS_RATE_LIMITED, { retryAfterMs })));

    const error = await refusal(service.link(ME, TYPED));

    expect(error.getResponse()).toMatchObject({
      code: 'UPSTREAM_THROTTLED',
      retryAfterMs: 60_000,
      message: t('errors.upstream_account.throttled', { upstream: Upstream.BoardGameGeek, seconds: 60 }),
    });
    expect((error as UpstreamThrottledException).retryAfterSeconds).toBe(60);
  });

  it('says one second, not 1 seconds, for a wait of a second or less', async () => {
    findUpstreamAccount.mockReturnValue(of(answer(ResultStatus.RESULT_STATUS_RATE_LIMITED, { retryAfterMs: 1_000 })));

    const error = await refusal(service.link(ME, TYPED));

    expect(error.getResponse()).toMatchObject({
      retryAfterMs: 1_000,
      message: t('errors.upstream_account.throttled_one_second', { upstream: Upstream.BoardGameGeek }),
    });
  });

  it('passes on the not-linkable refusal, asking no one, when no DataGateway is usable for the link', async () => {
    const notLinkable = new CodedHttpException(
      Http.Conflict,
      UpstreamAccountErrorCode.NotLinkable,
      t('errors.upstream_account.not_linkable_by_lookup', { upstream: Upstream.BoardGameGeek }),
    );
    linkDataGateway.mockRejectedValue(notLinkable);

    await expect(service.link(ME, TYPED)).rejects.toBe(notLinkable);

    expect(assertNotLinked).not.toHaveBeenCalled();
    expect(findUpstreamAccount).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('answers the already-linked refusal, asking no one, when the user has a BoardGameGeek account', async () => {
    const alreadyLinked = new CodedHttpException(
      Http.Conflict,
      UpstreamAccountErrorCode.AlreadyLinked,
      t('errors.upstream_account.already_linked', { upstream: Upstream.BoardGameGeek }),
    );
    assertNotLinked.mockRejectedValue(alreadyLinked);

    await expect(service.link(ME, TYPED)).rejects.toBe(alreadyLinked);

    expect(assertNotLinked).toHaveBeenCalledWith(ME, Upstream.BoardGameGeek);
    expect(findUpstreamAccount).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('passes on the store’s already-linked refusal for a link that raced another', async () => {
    const alreadyLinked = new CodedHttpException(
      Http.Conflict,
      UpstreamAccountErrorCode.AlreadyLinked,
      t('errors.upstream_account.already_linked', { upstream: Upstream.BoardGameGeek }),
    );
    create.mockRejectedValue(alreadyLinked);

    await expect(service.link(ME, TYPED)).rejects.toBe(alreadyLinked);
  });

  describe('UPSTREAM_UNREACHABLE (503), storing nothing', () => {
    it.each([
      ['an ERROR answer', () => of(answer(ResultStatus.RESULT_STATUS_ERROR, { message: 'DataGateway not connected' }))],
      ['an UNAVAILABLE answer', () => of(answer(ResultStatus.RESULT_STATUS_UNAVAILABLE))],
      ['a RESULT with no account', () => of(answer(ResultStatus.RESULT_STATUS_RESULT))],
      ['a RESULT with an empty external id', () => of(found({ account: { externalId: '', profileUrl: BGG_PROFILE } }))],
      ['a failed call', () => throwError(() => new Error('14 UNAVAILABLE: No connection established'))],
      ['a call that ends with no answer', () => EMPTY],
      [
        'a call that throws before it starts',
        () => {
          throw new Error('no actor in CLS');
        },
      ],
    ])('for %s', async (_name, call) => {
      findUpstreamAccount.mockImplementation(call);

      const error = await refusal(service.link(ME, TYPED));

      expect(error.getStatus()).toBe(Http.ServiceUnavailable);
      expect(error.code).toBe(UpstreamAccountErrorCode.Unreachable);
      expect(error.getResponse()).toMatchObject({
        message: t('errors.upstream_account.unreachable', { upstream: Upstream.BoardGameGeek }),
      });
      expect(create).not.toHaveBeenCalled();
    });

    // A user is waiting on the answer, and neither the coordinator nor this
    // client sets a gRPC deadline (#722), so the api bounds the wait itself,
    // and the timeout's unsubscribe cancels the call.
    it(`for a call that has not answered within ${BGG_LOOKUP_TIMEOUT_MS} ms, and not before, cancelling it`, async () => {
      jest.useFakeTimers();
      const teardown = jest.fn();
      findUpstreamAccount.mockReturnValue(new Observable<CoordinatorFindUpstreamAccountResponse>(() => teardown));
      let settled = false;
      const linking = service.link(ME, TYPED).finally(() => {
        settled = true;
      });
      const failure = linking.catch((error: unknown) => error);

      await jest.advanceTimersByTimeAsync(BGG_LOOKUP_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      expect(teardown).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(1);
      const error = await failure;

      expect(error).toBeInstanceOf(CodedHttpException);
      expect((error as CodedHttpException).code).toBe(UpstreamAccountErrorCode.Unreachable);
      expect(teardown).toHaveBeenCalledTimes(1);
      expect(create).not.toHaveBeenCalled();
    });
  });

  it('stores no display name when the DataGateway answers none', async () => {
    findUpstreamAccount.mockReturnValue(of(found({ account: { externalId: BGG_NAME, profileUrl: BGG_PROFILE } })));

    await service.link(ME, TYPED);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ displayName: null }));
  });

  it('stores no profile address that is not an http or https address', async () => {
    findUpstreamAccount.mockReturnValue(
      of(found({ account: { externalId: BGG_NAME, profileUrl: 'javascript:alert(1)' } })),
    );

    await service.link(ME, TYPED);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ profileUrl: null }));
  });
});
