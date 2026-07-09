import { redactSnapshot, toJsonValue } from './audit-snapshot.util';

describe('toJsonValue', () => {
  it('serializes Dates to ISO strings', () => {
    const value = toJsonValue({ createdAt: new Date('2026-01-15T10:00:00.000Z') });

    expect(value).toEqual({ createdAt: '2026-01-15T10:00:00.000Z' });
  });

  it('serializes bigint to decimal strings', () => {
    const value = toJsonValue({ big: BigInt('9007199254740993') });

    expect(value).toEqual({ big: '9007199254740993' });
  });

  it('drops undefined entries', () => {
    const value = toJsonValue({ kept: 'yes', dropped: undefined });

    expect(value).toEqual({ kept: 'yes' });
  });

  it('preserves nested nulls and objects', () => {
    const value = toJsonValue({ before: null, after: { id: 'g1', tags: ['a'] } });

    expect(value).toEqual({ before: null, after: { id: 'g1', tags: ['a'] } });
  });
});

describe('redactSnapshot', () => {
  it('passes null through (create/delete shapes)', () => {
    expect(redactSnapshot(null, ['passwordHash'])).toBeNull();
  });

  it('returns a copy when the denylist is empty', () => {
    const snapshot = { id: 'u1', email: 'a@b.c' };
    const result = redactSnapshot(snapshot, []);

    expect(result).toEqual(snapshot);
    expect(result).not.toBe(snapshot);
  });

  it('strips denied keys and keeps the rest', () => {
    const result = redactSnapshot({ id: 'u1', passwordHash: 'x', twoFactorSecret: 'y', name: 'Ada' }, [
      'passwordHash',
      'twoFactorSecret',
    ]);

    expect(result).toEqual({ id: 'u1', name: 'Ada' });
  });

  it('ignores denylist entries that are absent from the snapshot', () => {
    const result = redactSnapshot({ id: 'u1' }, ['passwordHash']);

    expect(result).toEqual({ id: 'u1' });
  });
});
