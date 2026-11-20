import { firstValueFrom } from 'rxjs';
import { invalidUpstreamAccountKey, upstreamAccountKeyOf } from './upstream-account-key.js';

/** A FindUpstreamAccount request looks an upstream account up by one key (#1226). */
describe('upstreamAccountKeyOf', () => {
  it('reads a username', () => {
    expect(upstreamAccountKeyOf({ correlationId: 'c', username: 'Ada' })).toEqual({ username: 'Ada' });
  });

  it('reads an external id', () => {
    expect(upstreamAccountKeyOf({ correlationId: 'c', externalId: '4217' })).toEqual({ externalId: '4217' });
  });

  it.each([
    ['neither key', {}],
    ['an empty username', { username: '' }],
    ['an empty external id', { externalId: '' }],
    ['both keys', { username: 'Ada', externalId: '4217' }],
  ])('reads no key from a request naming %s', (_label, key) => {
    expect(upstreamAccountKeyOf({ correlationId: 'c', ...key })).toBeUndefined();
  });

  it('reads the key that is set when the other is empty', () => {
    expect(upstreamAccountKeyOf({ correlationId: 'c', username: 'Ada', externalId: '' })).toEqual({ username: 'Ada' });
  });
});

describe('invalidUpstreamAccountKey', () => {
  it('errors with INVALID_ARGUMENT, saying what the request needs', async () => {
    await expect(firstValueFrom(invalidUpstreamAccountKey())).rejects.toMatchObject({
      code: 3,
      message: 'FindUpstreamAccount needs exactly one of a username and an external ID',
    });
  });
});
