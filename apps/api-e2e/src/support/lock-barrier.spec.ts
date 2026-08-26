import {
  BARRIER_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  BARRIER_LOCK_TIMEOUT_MS,
  BARRIER_STATEMENT_TIMEOUT_MS,
  barrierSessionSettings,
  describeUngrantedLocks,
  quoteIdentifier,
  type UngrantedLock,
} from './lock-barrier';

/**
 * The pure half of the barrier, unit-tested here so the DB-backed specs can
 * assume it. What the barrier DOES — that a second transaction blocks — is
 * only observable against a real Postgres, and lives in the household
 * concurrency specs.
 */
describe('quoteIdentifier', () => {
  it('quotes an ordinary schema name', () => {
    expect(quoteIdentifier('public')).toBe('"public"');
  });

  it('refuses anything it would have to be clever to quote', () => {
    // `search_path` cannot be parameterized, so the name is interpolated —
    // the same bargain `database-reset` makes for TRUNCATE, and the same
    // refusal rather than a cleverer quoting routine.
    for (const hostile of ['pub"lic', 'a;b', 'drop table x', '', '1schema']) {
      expect(() => quoteIdentifier(hostile)).toThrow(/refusing/i);
    }
  });
});

describe('barrierSessionSettings', () => {
  it('pins the schema the harness provisioned', () => {
    expect(barrierSessionSettings('public')).toContain('SET search_path TO "public"');
  });

  it('bounds every wait, so a leaked barrier fails its own test instead of the next one', () => {
    // D-239-3. The isolation sweep TRUNCATEs before every test and TRUNCATE
    // needs ACCESS EXCLUSIVE, so a connection left holding a transaction does
    // not fail here — it hangs the NEXT test until Jest's 120s timeout, and
    // reports in an unrelated spec.
    const settings = barrierSessionSettings('public').join('\n');

    expect(settings).toContain(`SET lock_timeout TO ${BARRIER_LOCK_TIMEOUT_MS}`);
    expect(settings).toContain(`SET statement_timeout TO ${BARRIER_STATEMENT_TIMEOUT_MS}`);
    expect(settings).toContain(`SET idle_in_transaction_session_timeout TO ${BARRIER_IDLE_IN_TRANSACTION_TIMEOUT_MS}`);
  });

  it('honors per-connection overrides', () => {
    const settings = barrierSessionSettings('public', { lockTimeoutMs: 250 }).join('\n');

    expect(settings).toContain('SET lock_timeout TO 250');
    expect(settings).toContain(`SET statement_timeout TO ${BARRIER_STATEMENT_TIMEOUT_MS}`);
  });
});

describe('describeUngrantedLocks', () => {
  const waiting: UngrantedLock = { locktype: 'transactionid', mode: 'ShareLock', relation: null };
  const tuple: UngrantedLock = { locktype: 'tuple', mode: 'ExclusiveLock', relation: 'household_roles' };

  it('renders what a blocked backend is waiting on', () => {
    expect(describeUngrantedLocks([waiting, tuple])).toBe(
      'transactionid/ShareLock, tuple/ExclusiveLock on household_roles',
    );
  });

  it('says so explicitly when nothing is ungranted, rather than rendering an empty string', () => {
    // This string lands in a failure message, and an empty one reads as a
    // truncated error rather than as "the statement was never blocked".
    expect(describeUngrantedLocks([])).toBe('no ungranted locks');
  });
});
