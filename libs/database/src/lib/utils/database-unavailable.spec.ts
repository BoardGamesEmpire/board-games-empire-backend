import { PrismaError } from '@status/codes';
import { Prisma } from '../client';
import { describeDatabaseError, isDatabaseUnavailableError } from './database-unavailable';
import {
  adminShutdown,
  clientInitializationFailed,
  connectionNotQueryable,
  connectionRefusedAtEveryAddress,
  connectionTerminated,
  databaseUnreachable,
  deadlock,
  serverClosedConnection,
  transactionExpired,
  transactionStartTimedOut,
  transactionWriteConflict,
  uniqueViolation,
  unmappedSocketError,
} from './prisma-error.fixtures';

const knownRequestError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('x', { code, clientVersion: 'test' });

describe('isDatabaseUnavailableError (#1172)', () => {
  // The shapes the real-database spec observed, database-unavailable-shape.spec.ts.
  it.each([
    ['a refused connection at a single address (P1001)', databaseUnreachable()],
    ['a connection refused at every address of the host (ECONNREFUSED)', connectionRefusedAtEveryAddress()],
    ['a server that closed the connection (P1017)', serverClosedConnection()],
    ['a backend ended under a model statement (57P01)', adminShutdown()],
    ['a backend ended under a raw statement (57P01)', adminShutdown({ statement: 'raw' })],
    ['a connection dropped mid-statement', connectionTerminated()],
    ['a statement on a connection that already failed', connectionNotQueryable()],
    ['a host with no route (EHOSTUNREACH)', unmappedSocketError('EHOSTUNREACH')],
    ['a resolver that is down (EAI_AGAIN)', unmappedSocketError('EAI_AGAIN')],
    ['a transaction that could not start in time (P2028)', transactionStartTimedOut()],
  ])('accepts %s', (_, error) => {
    expect(isDatabaseUnavailableError(error)).toBe(true);
  });

  it.each([
    ['a timed-out operation', PrismaError.OperationTimeout],
    ['too many database connections', PrismaError.TooManyDatabaseConnections],
  ])("accepts Prisma's own code for %s", (_, code) => {
    expect(isDatabaseUnavailableError(knownRequestError(code))).toBe(true);
  });

  it.each(['ENOTFOUND', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN', 'EPIPE', 'ECONNABORTED'])(
    'accepts a socket error the adapter left unmapped, %s, on a Prisma error',
    (code) => {
      expect(isDatabaseUnavailableError(knownRequestError(code))).toBe(true);
    },
  );

  describe.each([
    ['too many connections', '53300'],
    ['a crash shutdown', '57P02'],
    ['a server that cannot accept connections yet', '57P03'],
    ['a connection failure (class 08)', '08006'],
  ])('reads the SQLSTATE for %s', (_, sqlState) => {
    it.each([
      ['cause.originalCode', { cause: { kind: 'postgres', originalCode: sqlState } }],
      ['cause.code', { cause: { kind: 'postgres', code: sqlState } }],
      [
        'meta.driverAdapterError.cause.originalCode',
        { meta: { driverAdapterError: { cause: { originalCode: sqlState } } } },
      ],
    ])('at %s', (_, error) => {
      expect(isDatabaseUnavailableError(error)).toBe(true);
    });
  });

  // Like `isDeadlockError`, a Prisma code is read off any record.
  it("accepts a plain record carrying Prisma's P1001", () => {
    expect(isDatabaseUnavailableError({ code: 'P1001' })).toBe(true);
  });

  it.each([
    ['a unique violation', uniqueViolation()],
    ['a record not found (P2025)', knownRequestError(PrismaError.DependentRecordNotFound)],
    // A deadlock keeps its own 409, TRANSACTION_DEADLOCK: the database is up.
    ['a deadlock', deadlock()],
    ['a raw deadlock', deadlock({ shape: 'raw' })],
    ['a write conflict', transactionWriteConflict()],
    ['a programming error', new TypeError('x')],
    // Exact text only: our own wording around the driver's must not match.
    ['an error that only mentions a dropped connection', new Error('Upstream: Connection terminated unexpectedly')],
    // Redis and other clients use Node's socket codes too; those outages aren't the database's.
    ['a socket error that did not come through Prisma', Object.assign(new Error('connect'), { code: 'ECONNREFUSED' })],
    // P2028 is also the code's own slowness: only the start timeout is an outage.
    ['an expired transaction (P2028)', transactionExpired()],
    // Faults only the operator can clear keep the 500.
    ['wrong database credentials (P1000)', knownRequestError(PrismaError.AuthenticationFailed)],
    ['a database that does not exist (P1003)', knownRequestError(PrismaError.DatabaseDoesNotExist)],
    // With a driver adapter the client connects lazily, so failing to initialise is a setup fault.
    ['a client that could not be initialised', clientInitializationFailed()],
    // A bare cause counts only as a driver adapter's, which names a kind.
    [
      "another library's error whose cause carries a class 08 code",
      Object.assign(new Error('protocol violation'), { cause: { code: '08P01' } }),
    ],
    ['null', null],
    ['a bare Prisma code', 'P1001'],
  ])('rejects %s', (_, error) => {
    expect(isDatabaseUnavailableError(error)).toBe(false);
  });

  describe('describeDatabaseError', () => {
    it.each([
      ['an empty-message socket error', connectionRefusedAtEveryAddress(), 'code=ECONNREFUSED'],
      ['a mapped cause', databaseUnreachable(), 'code=P1001 kind=DatabaseNotReachable'],
      ['a SQLSTATE under meta', adminShutdown(), 'code=P2039 kind=postgres sqlstate=57P01'],
      ['a codeless driver error', connectionTerminated(), 'no code'],
      ['a non-object', 'P1001', 'no code'],
    ])('names the code of %s', (_, error, expected) => {
      expect(describeDatabaseError(error)).toBe(expected);
    });
  });
});
