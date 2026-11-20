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

const driverOver = (fetch: ConstructorParameters<typeof BoardGameGeekDriver>[0]['fetch']) =>
  new BoardGameGeekDriver({
    fetch,
    apiKey: 'test-key',
    version: '0.0.0-test',
    logger: silent,
    timing: { rateLimitRetryMs: 1 },
  });

// The answers in `testing/fixtures/user__*.xml` are built from BoardGameGeek's
// documented `xmlapi2/user` shape, not recorded from a live call (#1226).
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

  it('answers NOT_FOUND, not an error, when the user element has no id', async () => {
    const answer = await find({ username: 'nobody-by-this-name' });

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

  it('answers an upstream failure as an ERROR result carrying its message', async () => {
    const fetch = createFakeFetch(() => ({ status: 502, statusText: 'Bad Gateway' }));

    const answer = await find({ username: 'bgfan' }, driverOver(fetch));

    expect(answer.status).toBe(proto.ResultStatus.RESULT_STATUS_ERROR);
    expect(answer.message).toContain('502');
  });

  it('refuses a lookup by external id with INVALID_ARGUMENT, since BoardGameGeek keys users by name', async () => {
    const fetch = createFakeFetch(() => ({}));

    await expect(find({ externalId: 'BGFan' }, driverOver(fetch))).rejects.toMatchObject({ code: 3 });
    expect(fetch.requests).toHaveLength(0);
  });

  it('refuses a request naming no username with INVALID_ARGUMENT, without asking BoardGameGeek', async () => {
    const fetch = createFakeFetch(() => ({}));

    await expect(find({}, driverOver(fetch))).rejects.toMatchObject({ code: 3 });
    expect(fetch.requests).toHaveLength(0);
  });
});
