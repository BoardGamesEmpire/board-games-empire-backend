import {
  BARRIER_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  BARRIER_LOCK_TIMEOUT_MS,
  BARRIER_STATEMENT_TIMEOUT_MS,
  barrierSessionSettings,
  describeUngrantedLocks,
  expectAdvisoryWaiter,
  expectBlocked,
  expectNotBlocked,
  quoteIdentifier,
  type AdvisoryWaiter,
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

/**
 * Watching the LOCK rather than a backend.
 *
 * The pre-row races contend an application transaction against a barrier, and
 * the application's backend is not knowable from here: the request runs on a
 * connection from the API's own pool, and this suite never imports application
 * code. So the assertion is inverted — the holder asks whether anyone is queued
 * behind the key it holds — and the join against its own granted rows, plus the
 * caller's exclusion list, is what keeps that from meaning "anyone, anywhere".
 */
describe('expectAdvisoryWaiter', () => {
  const HOLDER_PID = 11;

  const stub = (label: string, pid: number, query: BarrierConnection['query']): BarrierConnection => ({
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

  const barrierWatching = (rows: readonly AdvisoryWaiter[], seen: unknown[][] = []): Barrier => ({
    holder: stub('holder', HOLDER_PID, (async () => []) as BarrierConnection['query']),
    waiter: stub('waiter', 12, (async () => []) as BarrierConnection['query']),
    observer: stub('observer', 13, (async (sql: string, params: readonly unknown[] = []) => {
      seen.push([sql, ...params]);

      return [...rows];
    }) as BarrierConnection['query']),
  });

  it('returns the waiting backend and what it is running', async () => {
    const waiter: AdvisoryWaiter = { pid: 99, query: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))' };

    await expect(
      expectAdvisoryWaiter(barrierWatching([waiter]), { heldBy: HOLDER_PID, description: 'the enable request' }),
    ).resolves.toEqual(waiter);
  });

  it('asks about the key the HOLDER holds, not about a pid it hopes is blocked', async () => {
    const seen: unknown[][] = [];

    await expectAdvisoryWaiter(barrierWatching([{ pid: 99, query: '' }], seen), {
      heldBy: HOLDER_PID,
      description: 'the enable request',
    });

    expect(seen[0]?.[0]).toMatch(/NOT waiting\.granted/);
    expect(seen[0]?.[1]).toBe(HOLDER_PID);
  });

  it('scopes the join to one database and orders the result', async () => {
    // pg_locks is cluster-wide while advisory locks are per-database, so
    // without the database predicate the same key on a shared server joins
    // across databases; without ORDER BY, a scenario with two contenders
    // returns a different one per run.
    const seen: unknown[][] = [];

    await expectAdvisoryWaiter(barrierWatching([{ pid: 99, query: '' }], seen), {
      heldBy: HOLDER_PID,
      description: 'the enable request',
    });

    expect(seen[0]?.[0]).toMatch(/held\.database = waiting\.database/);
    expect(seen[0]?.[0]).toMatch(/ORDER BY waiting\.pid/);
  });

  it('excludes the barrier’s own connections when the caller names them', async () => {
    // Without this a spec holding a key on `holder` and contending on `waiter`
    // reports the waiter and reads as though the application had queued — and
    // the query guard cannot catch it, because the barrier issues the shipped
    // advisory statement too.
    const seen: unknown[][] = [];

    await expectAdvisoryWaiter(barrierWatching([{ pid: 99, query: '' }], seen), {
      heldBy: HOLDER_PID,
      description: 'the enable request',
      exclude: [12, 13],
    });

    expect(seen[0]?.[2]).toEqual([HOLDER_PID, 12, 13]);
  });

  it('reports a request that answered instead of waiting, rather than timing out', async () => {
    // The failure this helper is most likely to see is a fixture problem — a
    // request that 403s never queues — and a timeout naming three possible
    // causes sends the reader to the lock instead of to the arrange.
    await expect(
      expectAdvisoryWaiter(barrierWatching([]), {
        heldBy: HOLDER_PID,
        description: 'the enable request',
        timeoutMs: 5_000,
        settledEarly: () => 'HTTP 403',
      }),
    ).rejects.toThrow(/answered without ever queueing behind the advisory key.*HTTP 403/s);
  });

  it('still times out when the request has neither queued nor answered', async () => {
    await expect(
      expectAdvisoryWaiter(barrierWatching([]), {
        heldBy: HOLDER_PID,
        description: 'the enable request',
        timeoutMs: 50,
        settledEarly: () => undefined,
      }),
    ).rejects.toThrow(/never waited on the advisory key/);
  });
});
