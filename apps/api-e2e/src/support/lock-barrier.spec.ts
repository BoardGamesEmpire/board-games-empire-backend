import {
  BARRIER_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  BARRIER_LOCK_TIMEOUT_MS,
  BARRIER_STATEMENT_TIMEOUT_MS,
  barrierSessionSettings,
  describeUngrantedLocks,
  expectBlocked,
  expectNotBlocked,
  quoteIdentifier,
  type Barrier,
  type BarrierConnection,
  type PendingStatement,
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

/**
 * Which backend the blocking assertions actually watch.
 *
 * They accept any {@link PendingStatement} but used to read `barrier.waiter.pid`
 * unconditionally, so a statement issued by the HOLDER — which the quota
 * deadlock case is the first in the suite to need — would have been judged
 * against the waiter's backend. The assertion passes while the holder never
 * blocked at all, which is the one outcome these helpers exist to rule out.
 */
describe('the blocking assertions watch the backend that issued the statement', () => {
  const HOLDER_PID = 1;
  const WAITER_PID = 2;

  const connection = (label: string, pid: number, query: BarrierConnection['query']): BarrierConnection => ({
    label,
    pid,
    query,
    begin: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    issue: () => {
      throw new Error('not used in this spec');
    },
    close: async () => undefined,
  });

  /** Records every pid the observer is asked about, answering `locks` for each. */
  const observing = (asked: number[], locks: readonly UngrantedLock[]): BarrierConnection =>
    connection('observer', 3, (async (sql: string, params: readonly unknown[] = []) => {
      asked.push(params[0] as number);

      return sql.includes('pg_locks') ? [...locks] : [];
    }) as BarrierConnection['query']);

  const pendingFrom = (pid: number, label: string): PendingStatement => ({
    description: `${label}: SELECT 1`,
    pid,
    settled: () => false,
    result: () => new Promise(() => undefined),
    failure: () => undefined,
  });

  const barrierWith = (observer: BarrierConnection): Barrier => ({
    holder: connection('holder', HOLDER_PID, (async () => []) as BarrierConnection['query']),
    waiter: connection('waiter', WAITER_PID, (async () => []) as BarrierConnection['query']),
    observer,
  });

  const held: UngrantedLock = { locktype: 'advisory', mode: 'ExclusiveLock', relation: null };

  it('asks about the holder’s backend for a holder-issued statement', async () => {
    const asked: number[] = [];

    await expectBlocked(barrierWith(observing(asked, [held])), pendingFrom(HOLDER_PID, 'holder'), { timeoutMs: 100 });

    expect(asked).toContain(HOLDER_PID);
    expect(asked).not.toContain(WAITER_PID);
  });

  it('names the issuing backend when a holder-issued statement never blocks', async () => {
    const asked: number[] = [];

    await expect(
      expectBlocked(barrierWith(observing(asked, [])), pendingFrom(HOLDER_PID, 'holder'), { timeoutMs: 50 }),
    ).rejects.toThrow(new RegExp(`pid ${HOLDER_PID}`));
  });

  it('reports the issuing backend from expectNotBlocked too', async () => {
    const asked: number[] = [];

    await expect(
      expectNotBlocked(barrierWith(observing(asked, [held])), pendingFrom(HOLDER_PID, 'holder'), { timeoutMs: 50 }),
    ).rejects.toThrow(new RegExp(`pid ${HOLDER_PID}`));
  });
});
