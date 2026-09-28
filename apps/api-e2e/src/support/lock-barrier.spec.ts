import {
  BARRIER_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  BARRIER_LOCK_TIMEOUT_MS,
  BARRIER_STATEMENT_TIMEOUT_MS,
  barrierSessionSettings,
  describeUngrantedLocks,
  expectAdvisoryWaiter,
  expectBackendsQueuedBehind,
  expectBlocked,
  expectLockWaiter,
  expectNotBlocked,
  quoteIdentifier,
  type AdvisoryWaiter,
  type Barrier,
  type BarrierConnection,
  type LockWaiter,
  type PendingStatement,
  type QueuedBackend,
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

/** The holder, waiter and observer pids the lock watchers below are handed. */
const WATCHED_HOLDER_PID = 11;
const WATCHED_WAITER_PID = 12;
const WATCHED_OBSERVER_PID = 13;

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

/** A barrier whose observer answers `rows` to every query, recording each query and its parameters in `seen`. */
const barrierWatching = (rows: readonly (AdvisoryWaiter | LockWaiter)[], seen: unknown[][] = []): Barrier => ({
  holder: stub('holder', WATCHED_HOLDER_PID, (async () => []) as BarrierConnection['query']),
  waiter: stub('waiter', WATCHED_WAITER_PID, (async () => []) as BarrierConnection['query']),
  observer: stub('observer', WATCHED_OBSERVER_PID, (async (sql: string, params: readonly unknown[] = []) => {
    seen.push([sql, ...params]);

    return [...rows];
  }) as BarrierConnection['query']),
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
  it('returns the waiting backend and what it is running', async () => {
    const waiter: AdvisoryWaiter = { pid: 99, query: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))' };

    await expect(
      expectAdvisoryWaiter(barrierWatching([waiter]), {
        heldBy: WATCHED_HOLDER_PID,
        description: 'the enable request',
      }),
    ).resolves.toEqual(waiter);
  });

  it('asks about the key the HOLDER holds, not about a pid it hopes is blocked', async () => {
    const seen: unknown[][] = [];

    await expectAdvisoryWaiter(barrierWatching([{ pid: 99, query: '' }], seen), {
      heldBy: WATCHED_HOLDER_PID,
      description: 'the enable request',
    });

    expect(seen[0]?.[0]).toMatch(/NOT waiting\.granted/);
    expect(seen[0]?.[1]).toBe(WATCHED_HOLDER_PID);
  });

  it('scopes the join to one database and orders the result', async () => {
    // pg_locks is cluster-wide while advisory locks are per-database, so
    // without the database predicate the same key on a shared server joins
    // across databases; without ORDER BY, a scenario with two contenders
    // returns a different one per run.
    const seen: unknown[][] = [];

    await expectAdvisoryWaiter(barrierWatching([{ pid: 99, query: '' }], seen), {
      heldBy: WATCHED_HOLDER_PID,
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
      heldBy: WATCHED_HOLDER_PID,
      description: 'the enable request',
      exclude: [12, 13],
    });

    expect(seen[0]?.[2]).toEqual([WATCHED_HOLDER_PID, 12, 13]);
  });

  it('reports a request that answered instead of waiting, rather than timing out', async () => {
    // The failure this helper is most likely to see is a fixture problem — a
    // request that 403s never queues — and a timeout naming three possible
    // causes sends the reader to the lock instead of to the arrange.
    await expect(
      expectAdvisoryWaiter(barrierWatching([]), {
        heldBy: WATCHED_HOLDER_PID,
        description: 'the enable request',
        timeoutMs: 5_000,
        settledEarly: () => 'HTTP 403',
      }),
    ).rejects.toThrow(/answered without ever queueing behind the advisory key.*HTTP 403/s);
  });

  it('still times out when the request has neither queued nor answered', async () => {
    await expect(
      expectAdvisoryWaiter(barrierWatching([]), {
        heldBy: WATCHED_HOLDER_PID,
        description: 'the enable request',
        timeoutMs: 50,
        settledEarly: () => undefined,
      }),
    ).rejects.toThrow(/never waited on the advisory key/);
  });
});

/**
 * The row-lock twin. A request blocked on a row waits on the holder's
 * transaction rather than on a key `pg_locks` can join against, so this asks
 * `pg_blocking_pids` instead. The polling and its failure reporting are shared
 * with `expectAdvisoryWaiter`; what differs, and is pinned here, is the
 * question sent.
 */
describe('expectLockWaiter', () => {
  it('returns the blocked backend and what it is running', async () => {
    const waiter: LockWaiter = { pid: 99, query: 'SELECT h.id FROM households h FOR NO KEY UPDATE' };

    await expect(
      expectLockWaiter(barrierWatching([waiter]), { heldBy: WATCHED_HOLDER_PID, description: 'the transfer request' }),
    ).resolves.toEqual(waiter);
  });

  it('asks who the HOLDER is blocking, which reaches a backend waiting on a row', async () => {
    const seen: unknown[][] = [];

    await expectLockWaiter(barrierWatching([{ pid: 99, query: '' }], seen), {
      heldBy: WATCHED_HOLDER_PID,
      description: 'the transfer request',
    });

    expect(seen[0]?.[0]).toMatch(/\$1 = ANY\(pg_blocking_pids\(activity\.pid\)\)/);
    expect(seen[0]?.[0]).toMatch(/ORDER BY activity\.pid/);
    expect(seen[0]?.[1]).toBe(WATCHED_HOLDER_PID);
  });

  it('excludes the holder and the barrier’s own connections', async () => {
    const seen: unknown[][] = [];

    await expectLockWaiter(barrierWatching([{ pid: 99, query: '' }], seen), {
      heldBy: WATCHED_HOLDER_PID,
      description: 'the transfer request',
      exclude: [12, 13],
    });

    expect(seen[0]?.[2]).toEqual([WATCHED_HOLDER_PID, 12, 13]);
  });

  it('reports a request that answered instead of waiting, rather than timing out', async () => {
    await expect(
      expectLockWaiter(barrierWatching([]), {
        heldBy: WATCHED_HOLDER_PID,
        description: 'the transfer request',
        timeoutMs: 5_000,
        settledEarly: () => 'HTTP 404',
      }),
    ).rejects.toThrow(/answered without ever waiting on a lock held by pid 11.*HTTP 404/s);
  });

  it('still times out when the request has neither waited nor answered', async () => {
    await expect(
      expectLockWaiter(barrierWatching([]), {
        heldBy: WATCHED_HOLDER_PID,
        description: 'the transfer request',
        timeoutMs: 50,
        settledEarly: () => undefined,
      }),
    ).rejects.toThrow(/never waited on a lock held by pid 11/);
  });
});

/**
 * `expectLockWaiter`'s question asked of the whole queue: how many backends
 * are queued behind the holder, directly or behind one another. Signup
 * provisioning contends two application transactions for an advisory key of
 * their own while one of them waits on the holder's row lock, so a query for
 * direct waiters alone would see one backend where two are queued.
 */
describe('expectBackendsQueuedBehind', () => {
  it('returns once the requested number of backends is queued', async () => {
    const queued: QueuedBackend[] = [
      { pid: 98, query: 'INSERT INTO "user_roles"' },
      { pid: 99, query: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))' },
    ];

    await expect(
      expectBackendsQueuedBehind(barrierWatching(queued), {
        heldBy: WATCHED_HOLDER_PID,
        count: 2,
        description: 'two signups',
      }),
    ).resolves.toEqual(queued);
  });

  it('follows the chain: a backend waiting on a waiter counts, not only one waiting on the holder', async () => {
    const seen: unknown[][] = [];

    await expectBackendsQueuedBehind(barrierWatching([{ pid: 99, query: '' }], seen), {
      heldBy: WATCHED_HOLDER_PID,
      count: 1,
      description: 'one signup',
    });

    expect(seen[0]?.[0]).toMatch(/WITH RECURSIVE/);
    expect(seen[0]?.[0]).toMatch(/JOIN queued ON queued\.pid = ANY\(waiting\.blockers\)/);
    expect(seen[0]?.[1]).toBe(WATCHED_HOLDER_PID);
  });

  it("scopes the search to one database, orders it, and never counts or chains through the barrier's own connections", async () => {
    // A spec that also contends on `waiter` would otherwise see its own
    // statement and read it as the application queueing, or count a backend
    // queued behind the waiter as queued behind the holder.
    const seen: unknown[][] = [];

    await expectBackendsQueuedBehind(barrierWatching([{ pid: 99, query: '' }], seen), {
      heldBy: WATCHED_HOLDER_PID,
      count: 1,
      description: 'one signup',
    });

    const sql = String(seen[0]?.[0]);

    expect(sql).toMatch(/datname = current_database\(\)/);
    expect(sql).toMatch(/ORDER BY waiting\.pid/);
    // Left out of `waiting`, which both the first step and the chain draw from.
    expect(sql).toMatch(/waiting AS MATERIALIZED \([\s\S]*pid <> ALL\(\$2::int\[\]\)[\s\S]*queued\(pid\) AS/);
    expect(seen[0]?.[2]).toEqual([WATCHED_HOLDER_PID, WATCHED_WAITER_PID, WATCHED_OBSERVER_PID]);
  });

  it('asks for blockers once per poll, and only of backends waiting on a lock', async () => {
    // `pg_blocking_pids` briefly takes the lock manager's locks, and this
    // polls beside the very transactions it watches.
    const seen: unknown[][] = [];

    await expectBackendsQueuedBehind(barrierWatching([{ pid: 99, query: '' }], seen), {
      heldBy: WATCHED_HOLDER_PID,
      count: 1,
      description: 'one signup',
    });

    const sql = String(seen[0]?.[0]);

    expect(sql.match(/pg_blocking_pids/g)).toHaveLength(1);
    expect(sql).toMatch(/wait_event_type = 'Lock'/);
  });

  it('names how many were queued when fewer than requested ever arrive', async () => {
    await expect(
      expectBackendsQueuedBehind(barrierWatching([{ pid: 99, query: 'INSERT INTO "user_roles"' }]), {
        heldBy: WATCHED_HOLDER_PID,
        count: 2,
        description: 'two signups',
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/Expected 2 backend\(s\) queued behind pid 11 for two signups, but .* there were 1 \(pid 99/);
  });
});
