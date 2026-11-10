import { PrismaError } from '@status/codes';
import { Prisma } from '../client';
import { DEADLOCK_SQLSTATE, isDeadlockError, retryOnDeadlock } from './deadlock';
import { deadlock, transactionWriteConflict, uniqueViolation } from './prisma-error.fixtures';

describe('isDeadlockError', () => {
  it('accepts the P2034 a model write raises — the model-write shape', () => {
    expect(isDeadlockError(deadlock())).toBe(true);
  });

  it('reads the SQLSTATE out of meta.driverAdapterError — the raw-statement shape', () => {
    expect(isDeadlockError(deadlock({ shape: 'raw' }))).toBe(true);
  });

  // The model-write shape up to @prisma/adapter-pg 7.8, kept classified so a
  // regression to it cannot bring back #398's untyped 500.
  it('reads the SQLSTATE off a bare DriverAdapterError — the pre-7.10 model-write shape', () => {
    expect(isDeadlockError(deadlock({ shape: 'bare' }))).toBe(true);
  });

  it('falls back to the postgres passthrough `code` when originalCode is gone', () => {
    expect(isDeadlockError(deadlock({ shape: 'bare', omitOriginalCode: true }))).toBe(true);
  });

  it("accepts Prisma's own P2034, which means a write conflict or a deadlock", () => {
    expect(isDeadlockError(transactionWriteConflict())).toBe(true);
  });

  it('rejects a unique violation, which is a different answer entirely', () => {
    expect(isDeadlockError(uniqueViolation())).toBe(false);
  });

  it('rejects a P2010 whose SQLSTATE is some other raw failure', () => {
    const otherRawFailure = new Prisma.PrismaClientKnownRequestError('Raw query failed', {
      code: PrismaError.RawQueryFailed,
      clientVersion: 'test',
      meta: { driverAdapterError: deadlock({ shape: 'bare', sqlState: '42P01' }) },
    });

    expect(isDeadlockError(otherRawFailure)).toBe(false);
  });

  it('rejects a plain Error, and anything that is not an object', () => {
    expect(isDeadlockError(new Error('deadlock detected'))).toBe(false);
    expect(isDeadlockError('40P01')).toBe(false);
    expect(isDeadlockError(null)).toBe(false);
    expect(isDeadlockError(undefined)).toBe(false);
  });

  it('names the SQLSTATE it looks for', () => {
    expect(DEADLOCK_SQLSTATE).toBe('40P01');
  });
});

describe('retryOnDeadlock', () => {
  it('returns the first attempt when nothing deadlocks', async () => {
    const operation = jest.fn<Promise<string>, []>().mockResolvedValue('first');

    await expect(retryOnDeadlock(operation)).resolves.toBe('first');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('runs the operation again when the first attempt deadlocks', async () => {
    const operation = jest.fn<Promise<string>, []>().mockRejectedValueOnce(deadlock()).mockResolvedValue('second');

    await expect(retryOnDeadlock(operation)).resolves.toBe('second');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('gives up after the second deadlock rather than looping', async () => {
    const second = deadlock();
    const operation = jest.fn<Promise<string>, []>().mockRejectedValueOnce(deadlock()).mockRejectedValueOnce(second);

    await expect(retryOnDeadlock(operation)).rejects.toBe(second);
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('never retries an error that is not a deadlock', async () => {
    const violation = uniqueViolation();
    const operation = jest.fn<Promise<string>, []>().mockRejectedValue(violation);

    await expect(retryOnDeadlock(operation)).rejects.toBe(violation);
    expect(operation).toHaveBeenCalledTimes(1);
  });
});
