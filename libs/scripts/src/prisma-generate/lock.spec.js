'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crypto = require('node:crypto');

const { createLock, LOCK_STALE_MS, LOCK_TIMEOUT_MS } = require('./lock');

const DEAD_PID = 999;
const STALE_MS = 10_000;
const TIMEOUT_MS = 60_000;

/**
 * Starts at the real clock because reclaim compares the injected `now()` against
 * the lock's real filesystem mtime.
 */
function fakeClock() {
  let t = Date.now();
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

function attempt(lock) {
  try {
    lock.acquire();
    return true;
  } catch {
    return false;
  }
}

describe('prisma-generate lock', () => {
  let dir;
  let lockPath;
  let clock;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bge-lock-'));
    lockPath = path.join(dir, 'lock');
    clock = fakeClock();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function lockFor(pid, overrides = {}) {
    return createLock({
      lockPath,
      pid,
      now: overrides.now ?? clock.now,
      sleep: (ms) => clock.advance(ms),
      processAlive: overrides.processAlive ?? (() => true),
      staleMs: STALE_MS,
      timeoutMs: TIMEOUT_MS,
      ...overrides.options,
    });
  }

  /** A lock with no readable owner — what a kill mid-acquire used to leave. */
  function plantOwnerlessLock() {
    fs.writeFileSync(lockPath, '');
  }

  /** A lock whose owner record was truncated by a crash mid-write. */
  function plantTornLock() {
    fs.writeFileSync(lockPath, '{"pid":123,"acqui');
  }

  /** A lock held by `pid`, as this process would write it. */
  function plantLock(pid) {
    const holder = lockFor(pid);
    holder.acquire();
    expect(holder.inspect()).toMatchObject({ pid });
    return holder;
  }

  it('keeps the shipped staleness threshold reachable by a single waiter', () => {
    // A waiter that gives up before the lock it waits on can be reclaimed leaves
    // every recovery to some later invocation (#338).
    expect(LOCK_STALE_MS).toBeLessThan(LOCK_TIMEOUT_MS);

    expect(() => createLock({ lockPath, staleMs: LOCK_TIMEOUT_MS, timeoutMs: LOCK_TIMEOUT_MS })).toThrow(
      /must be below timeoutMs/,
    );
  });

  it('reclaims an ownerless lock within a single waiter lifetime', () => {
    plantOwnerlessLock();

    const lock = lockFor(4242);

    expect(() => lock.acquire()).not.toThrow();
    expect(lock.inspect()).toMatchObject({ pid: 4242 });
  });

  it('leaves a torn owner record alone until the grace period has passed', () => {
    plantTornLock();

    const started = clock.now();
    const lock = lockFor(4242);

    expect(() => lock.acquire()).not.toThrow();
    expect(clock.now() - started).toBeGreaterThan(1_000);
  });

  it('does not fail the run when the lock disappears while it is being inspected', () => {
    // A torn record, not an empty directory: the lock has to stay occupied long
    // enough for the poll loop to reach the inspection at all.
    plantTornLock();

    let calls = 0;
    const lock = lockFor(4242, {
      now: () => {
        // The holder releases mid-inspection: by call three the poll loop is
        // between reading the owner record and stat-ing the lock.
        if (++calls === 3) fs.rmSync(lockPath, { recursive: true, force: true });
        return clock.now();
      },
    });

    expect(() => lock.acquire()).not.toThrow();
  });

  it('leaves exactly one holder when two waiters reclaim the same dead lock', () => {
    plantLock(DEAD_PID);

    const second = lockFor(200, { processAlive: (queried) => queried !== DEAD_PID });
    let secondWon = false;

    const first = lockFor(100, {
      processAlive: (queried) => {
        if (queried === DEAD_PID && !secondWon) {
          // The other waiter completes its whole reclaim while we are still
          // deciding about the record we already read.
          secondWon = attempt(second);
        }
        return queried !== DEAD_PID;
      },
      // One poll only: what matters is the reclaim decision taken against the
      // record we read before the other waiter moved.
      options: {
        sleep: () => {
          throw new Error('one poll only');
        },
      },
    });

    const firstWon = attempt(first);

    expect([firstWon, secondWon].filter(Boolean)).toHaveLength(1);
    expect(lockOwner()).toBe(200);
  });

  it('does not take the lock from a live holder that replaced a stale one', () => {
    plantLock(DEAD_PID);

    let interleaved = false;
    const waiter = lockFor(100, {
      processAlive: (queried) => {
        if (queried === DEAD_PID && !interleaved) {
          // Another waiter reclaims the dead lock and a fresh process takes it,
          // between our read of the owner record and our decision to act on it.
          interleaved = true;
          fs.rmSync(lockPath, { force: true });
          plantLock(777);
        }
        return queried !== DEAD_PID;
      },
      // One poll only: what matters is the first reclaim decision.
      options: {
        sleep: () => {
          throw new Error('one poll only');
        },
      },
    });

    expect(() => waiter.acquire()).toThrow('one poll only');
    expect(interleaved).toBe(true);
    expect(lockOwner()).toBe(777);
  });

  it('names the current holder when it gives up', () => {
    // Under the staleMs < timeoutMs invariant a single holder is always freed
    // before the deadline, so the timeout is only reachable under real churn:
    // a fresh holder keeps taking the lock between our polls.
    let holder = 900;
    plantLock(holder);

    const waiter = lockFor(100, {
      options: {
        sleep: (ms) => {
          clock.advance(ms);
          fs.rmSync(lockPath, { force: true });
          plantLock(++holder);
        },
      },
    });

    expect(() => waiter.acquire()).toThrow(/Timed out after \d+ms .* \(held by pid \d+\)/);
    expect(lockOwner()).toBe(holder);
  });

  it('never rewrites a live lock while failing to acquire it', () => {
    plantLock(300);
    const before = fs.readFileSync(lockPath, 'utf8');

    // A staging file leaked by an earlier process that died between its `link`
    // and its cleanup is still hard-linked to the live lock: same inode, two
    // names. A later process that reuses the pid must not write through it.
    fs.linkSync(lockPath, `${lockPath}.300.0`);

    // Enough that the contender's record differs from the holder's; nowhere near
    // the staleness threshold, so the holder stays live.
    clock.advance(1);

    const contender = lockFor(300, {
      options: {
        sleep: () => {
          throw new Error('one poll only');
        },
      },
    });

    expect(() => contender.acquire()).toThrow('one poll only');
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(before);
    expect(lockOwner()).toBe(300);
  });

  it('steps to a fresh staging name rather than writing through a leaked one', () => {
    plantLock(300);
    const before = fs.readFileSync(lockPath, 'utf8');
    clock.advance(1);

    // Force the collision the unguessable name normally prevents, so the
    // exclusive-create guard is the only thing standing between the contender and
    // the live lock's bytes.
    const names = ['collides', 'collides', 'fresh'];
    const uuid = jest.spyOn(crypto, 'randomUUID').mockImplementation(() => names.shift() ?? 'fresh');
    fs.linkSync(lockPath, `${lockPath}.staging.300.collides`);

    const contender = lockFor(300, {
      options: {
        sleep: () => {
          throw new Error('one poll only');
        },
      },
    });

    try {
      expect(() => contender.acquire()).toThrow('one poll only');

      // Proof the collision path actually ran: both colliding names were consumed.
      expect(names).toEqual([]);
      expect(fs.existsSync(`${lockPath}.staging.300.collides`)).toBe(true);

      expect(fs.readFileSync(lockPath, 'utf8')).toBe(before);
      expect(lockOwner()).toBe(300);
    } finally {
      uuid.mockRestore();
    }
  });

  it('does not assume ownership of a stale lock it merely freed', () => {
    plantLock(DEAD_PID);

    const competitor = lockFor(555);
    let competitorTook = false;
    let calls = 0;

    const waiter = lockFor(100, {
      processAlive: (queried) => queried !== DEAD_PID,
      // By the fourth reading the stale lock has been freed and we are staging a
      // fresh record: someone who was never waiting links first and wins.
      now: () => {
        if (++calls === 4 && !competitorTook) competitorTook = attempt(competitor);
        return clock.now();
      },
      options: {
        sleep: () => {
          throw new Error('stop once the lock has an owner again');
        },
      },
    });

    expect(() => waiter.acquire()).toThrow('stop once the lock has an owner again');
    expect(competitorTook).toBe(true);
    expect(lockOwner()).toBe(555);
  });

  it('does not remove a lock that was reclaimed while it was held', () => {
    const held = lockFor(100);
    held.acquire();

    // The run outlives the staleness threshold while its process is still alive,
    // so a waiter reclaims it and takes ownership.
    clock.advance(STALE_MS + 1);
    const reclaimer = lockFor(200);
    expect(attempt(reclaimer)).toBe(true);
    expect(lockOwner()).toBe(200);

    held.release();

    expect(lockOwner()).toBe(200);
  });

  function lockOwner() {
    return lockFor(0).inspect()?.pid ?? null;
  }
});
