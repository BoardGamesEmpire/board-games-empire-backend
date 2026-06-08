import { JOB_META_KEY, type JobActorMeta, extractJobMeta, wrapJobData } from './job-meta';
import type { Actor } from './types';

const actor: Actor = {
  kind: 'user',
  userId: 'user-1',
};
const meta: JobActorMeta = { actor, correlationId: 'corr-1' };

describe('wrapJobData', () => {
  it('attaches the meta envelope under __meta', () => {
    const wrapped = wrapJobData({ gameId: 'g1' }, meta);

    expect(wrapped).toEqual({
      gameId: 'g1',
      [JOB_META_KEY]: meta,
    });
  });

  it('preserves the original payload fields', () => {
    const wrapped = wrapJobData({ a: 1, b: 'two', c: { nested: true } }, meta);

    expect(wrapped.a).toBe(1);
    expect(wrapped.b).toBe('two');
    expect(wrapped.c).toEqual({ nested: true });
  });

  it('does not mutate the input payload', () => {
    const payload = { gameId: 'g1' };
    wrapJobData(payload, meta);
    expect(payload).toEqual({ gameId: 'g1' });
    expect(JOB_META_KEY in payload).toBe(false);
  });
});

describe('extractJobMeta', () => {
  it('round-trips with wrapJobData', () => {
    const wrapped = wrapJobData({ gameId: 'g1' }, meta);
    expect(extractJobMeta(wrapped)).toEqual(meta);
  });

  it('returns null when data is undefined', () => {
    expect(extractJobMeta(undefined)).toBeNull();
  });

  it('returns null when data is null', () => {
    expect(extractJobMeta(null)).toBeNull();
  });

  it('returns null when data is a primitive', () => {
    expect(extractJobMeta(42)).toBeNull();
    expect(extractJobMeta('string')).toBeNull();
  });

  it('returns null when __meta is missing', () => {
    expect(extractJobMeta({ gameId: 'g1' })).toBeNull();
  });

  it('returns null when __meta is malformed (missing actor)', () => {
    expect(extractJobMeta({ [JOB_META_KEY]: { correlationId: 'c' } })).toBeNull();
  });

  it('returns null when __meta is malformed (missing correlationId)', () => {
    expect(extractJobMeta({ [JOB_META_KEY]: { actor } })).toBeNull();
  });

  it('returns null when correlationId is not a string', () => {
    expect(
      extractJobMeta({
        [JOB_META_KEY]: { actor, correlationId: 123 },
      }),
    ).toBeNull();
  });
});
