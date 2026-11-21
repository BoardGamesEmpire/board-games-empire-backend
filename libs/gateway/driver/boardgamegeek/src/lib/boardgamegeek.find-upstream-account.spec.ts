import type { DriverLogger } from '@boardgamesempire/gateway-driver-contract';
import { createFakeFetch } from '@boardgamesempire/gateway-driver-contract-testing';
import * as proto from '@boardgamesempire/proto-gateway';
import { join } from 'node:path';
import { firstValueFrom } from 'rxjs';
import { BoardGameGeekDriver } from './boardgamegeek.driver';
import { bggFixtureFetch } from './testing/bgg-fixture-fetch';

const FIXTURES = join(__dirname, '..', 'testing', 'fixtures');

const silent: DriverLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

type DriverOptions = ConstructorParameters<typeof BoardGameGeekDriver>[0];

const driverOver = (fetch: DriverOptions['fetch'], timing: DriverOptions['timing'] = {}) =>
  new BoardGameGeekDriver({
    fetch,
    apiKey: 'test-key',
    version: '0.0.0-test',
    logger: silent,
    timing: { rateLimitRetryMs: 1, ...timing },
  });

// `testing/fixtures/user__*` follow BoardGameGeek's live `xmlapi2/user`
// answers, checked 2026-11-20: a known user is a `<user>` with `id` and `name`
// in BoardGameGeek's capitals, and an unknown name is a 404 HTML page (#1226).
// The known user is made up, so the fixture names no real person.
describe('BoardGameGeekDriver findUpstreamAccount (#1226)', () => {
  const find = (request: Partial<proto.FindUpstreamAccountRequest>, driver = driverOver(bggFixtureFetch(FIXTURES))) =>
    firstValueFrom(driver.findUpstreamAccount({ correlationId: 'find', ...request }));

  it('finds a username, answering the name as BoardGameGeek writes it', async () => {
    const answer = await find({ username: 'bgfan' });

    expect(answer).toEqual({
      correlationId: 'find',
      status: proto.ResultStatus.RESULT_STATUS_RESULT,
      account: { externalId: 'BGFan', displayName: 'BGFan', profileUrl: 'https://boardgamegeek.com/user/BGFan' },
    });
  });

  it('percent-encodes a name in the profile address and in the request', async () => {
    const fetch = createFakeFetch(() => ({
      body: '<user id="9" name="Mary Ann&amp;Co" termsofuse=""></user>',
    }));

    const answer = await find({ username: 'Mary Ann&Co' }, driverOver(fetch));

    expect(fetch.requests[0].url.href).toBe('https://boardgamegeek.com/xmlapi2/user?name=Mary%20Ann%26Co');
    expect(answer.account?.profileUrl).toBe('https://boardgamegeek.com/user/Mary%20Ann%26Co');
  });

  // A `#` left as it is would end the address at a fragment, and a name
  // beyond ASCII goes as its UTF-8 bytes.
  it('percent-encodes a # and a name beyond ASCII', async () => {
    const fetch = createFakeFetch(() => ({ body: '<user id="9" name="Jürgen #1" termsofuse=""></user>' }));

    const answer = await find({ username: 'Jürgen #1' }, driverOver(fetch));

    expect(fetch.requests[0].url.href).toBe('https://boardgamegeek.com/xmlapi2/user?name=J%C3%BCrgen%20%231');
    expect(answer.account).toEqual({
      externalId: 'Jürgen #1',
      displayName: 'Jürgen #1',
      profileUrl: 'https://boardgamegeek.com/user/J%C3%BCrgen%20%231',
    });
  });

  it('answers NOT_FOUND, not an error, when BoardGameGeek answers 404 for the name', async () => {
    const answer = await find({ username: 'nobody-by-this-name' });

    expect(answer).toEqual({ correlationId: 'find', status: proto.ResultStatus.RESULT_STATUS_NOT_FOUND });
  });

  it('answers NOT_FOUND, not an error, when the user element has no id', async () => {
    const fetch = createFakeFetch(() => ({ body: '<user id="" termsofuse=""></user>' }));

    const answer = await find({ username: 'nobody-by-this-name' }, driverOver(fetch));

    expect(answer).toEqual({ correlationId: 'find', status: proto.ResultStatus.RESULT_STATUS_NOT_FOUND });
  });

  it('answers RATE_LIMITED with retry_after_ms when BoardGameGeek throttles the call', async () => {
    const fetch = createFakeFetch(() => ({
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'retry-after': '120' },
    }));

    const answer = await find({ username: 'bgfan' }, driverOver(fetch));

    expect(answer).toEqual({
      correlationId: 'find',
      status: proto.ResultStatus.RESULT_STATUS_RATE_LIMITED,
      retryAfterMs: 120_000,
    });
  });

  it('answers RATE_LIMITED with the wait it would have used when BoardGameGeek names none', async () => {
    const fetch = createFakeFetch(() => ({ status: 429, statusText: 'Too Many Requests' }));

    const answer = await find({ username: 'bgfan' }, driverOver(fetch));

    expect(answer.status).toBe(proto.ResultStatus.RESULT_STATUS_RATE_LIMITED);
    expect(answer.retryAfterMs).toEqual(expect.any(Number));
  });

  it('asks again once after a 429, and answers what the second call finds', async () => {
    let calls = 0;
    const fetch = createFakeFetch(() =>
      ++calls === 1
        ? { status: 429, statusText: 'Too Many Requests' }
        : { body: '<user id="7" name="BGFan" termsofuse=""></user>' },
    );

    const answer = await find({ username: 'bgfan' }, driverOver(fetch));

    expect(fetch.requests).toHaveLength(2);
    expect(answer).toEqual(expect.objectContaining({ status: proto.ResultStatus.RESULT_STATUS_RESULT }));
    expect(answer.account?.externalId).toBe('BGFan');
  });

  // None of these says whether the user exists, so none may read as NOT_FOUND:
  // a link would tell the user their username is wrong (#1226).
  it.each([
    ['an empty body', createFakeFetch(() => ({ body: '' })), {}],
    [
      'an <errors> body',
      createFakeFetch(() => ({ body: '<errors><error><message>Rate limit exceeded.</message></error></errors>' })),
      {},
    ],
    [
      'a 202 that never turns into an answer',
      createFakeFetch(() => ({ status: 202, statusText: 'Accepted' })),
      { acceptedRetries: 1, acceptedRetryMs: 1 },
    ],
  ])('answers %s as an ERROR result, never NOT_FOUND', async (_name, fetch, timing) => {
    const answer = await find({ username: 'bgfan' }, driverOver(fetch, timing));

    expect(answer.status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
  });

  it('answers an upstream failure as an ERROR result carrying its message', async () => {
    const fetch = createFakeFetch(() => ({ status: 502, statusText: 'Bad Gateway' }));

    const answer = await find({ username: 'bgfan' }, driverOver(fetch));

    expect(answer.status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
    expect(answer.message).toContain('502');
  });

  it("logs a failed lookup by the error's name, never its message, which can quote the username", async () => {
    const error = jest.fn();
    const fetch: DriverOptions['fetch'] = () =>
      Promise.reject(new Error('Request to https://boardgamegeek.com/xmlapi2/user?name=bgfan timed out'));
    const driver = new BoardGameGeekDriver({
      fetch,
      apiKey: 'test-key',
      version: '0.0.0-test',
      logger: { ...silent, error },
      timing: { rateLimitRetryMs: 1 },
    });

    const answer = await find({ username: 'bgfan' }, driver);

    expect(answer.status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
    expect(error).toHaveBeenCalledWith('findUpstreamAccount failed: Error');
    expect(JSON.stringify(error.mock.calls)).not.toContain('bgfan');
  });

  // BoardGameGeek keys users by name, so an account's external id is its
  // username, and a lookup by it is the same request with the same answer.
  it('looks an external id up as the username it is: the same request, the same answer', async () => {
    const nameFetch = bggFixtureFetch(FIXTURES);
    const idFetch = bggFixtureFetch(FIXTURES);

    const byName = await find({ username: 'bgfan' }, driverOver(nameFetch));
    const byId = await find({ externalId: 'bgfan' }, driverOver(idFetch));

    expect(byId).toEqual(byName);
    expect(byId.status).toBe(proto.ResultStatus.RESULT_STATUS_RESULT);
    expect(idFetch.requests.map(({ url }) => url.href)).toEqual(nameFetch.requests.map(({ url }) => url.href));
  });

  it('answers an external id BoardGameGeek has no user by NOT_FOUND', async () => {
    const answer = await find({ externalId: 'nobody-by-this-name' });

    expect(answer).toEqual({ correlationId: 'find', status: proto.ResultStatus.RESULT_STATUS_NOT_FOUND });
  });

  it('refuses a request naming no username with INVALID_ARGUMENT, without asking BoardGameGeek', async () => {
    const fetch = createFakeFetch(() => ({}));

    await expect(find({}, driverOver(fetch))).rejects.toMatchObject({ code: 3 });
    expect(fetch.requests).toHaveLength(0);
  });
});
