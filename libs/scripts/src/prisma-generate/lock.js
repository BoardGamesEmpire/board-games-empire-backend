'use strict';
/**
 * Exclusive lock for `prisma generate`.
 *
 * The lock is a single JSON file naming its holder, and two filesystem
 * guarantees carry the whole design:
 *
 *   - `link` creates the lock or fails, and the file it creates already carries
 *     the complete owner record. So exactly one caller can take a free lock, and
 *     a lock is never observable without knowing who holds it.
 *   - `rename` moving the lock ASIDE is exclusive: two waiters that both judged
 *     the same holder stale cannot both move it, because the loser's rename hits
 *     ENOENT. That is what stops two reclaimers both concluding they hold it.
 *
 * Freeing a stale lock and taking it are separate steps. A reclaimer frees the
 * lock and then competes for it through the ordinary `link` like anyone else, so
 * the winner is whoever links first — possibly a process that was never waiting.
 * Replacing the lock in place instead would let every reclaimer's rename succeed
 * in turn, each reading back its own record and concluding it owns the lock: two
 * concurrent generates, which is the defect this exists to prevent.
 *
 * What is NOT closed, because no filesystem primitive offers compare-and-swap on
 * file contents: a reclaimer can still evict a holder that took over between the
 * reclaimer's confirming read and its rename. Those are two adjacent syscalls
 * with nothing in between, deliberately (#338).
 *
 * The clock, process liveness, and the poll wait are injected so the reclaim
 * races can be driven deterministically instead of chased with signals.
 */
const fs = require('node:fs');

/**
 * How long to wait for another process's generate before giving up.
 *
 * Longer than LOCK_STALE_MS, and that ordering is the whole point: a waiter that
 * gave up first could never reclaim the lock it was waiting on, so recovery
 * always fell to some later invocation.
 */
const LOCK_TIMEOUT_MS = 180_000;
/**
 * A lock is stale once its owner is gone, or once it has outlived any plausible
 * run. A cold `prisma generate` in this workspace measured 1.4s on 2026-08-19,
 * so two minutes is ~85x the real thing, or ~8x a CI machine ten times slower.
 *
 * The margin is deliberately generous, because the two ways of getting this
 * wrong are not equally bad. Too short evicts a slow-but-working generate and
 * lets a second one run against the same output directory — the exact corruption
 * this wrapper exists to prevent. Too long leaves a genuinely hung generate
 * blocking its waiters until the timeout below fires, which reports a clear
 * message naming the lock and what to remove. Availability is the cheaper thing
 * to lose, so it is what gets traded.
 *
 * `processAlive` already covers an owner that *died*; this threshold exists only
 * for one that is alive and stuck, which no wall-clock number can distinguish
 * from one that is alive and slow.
 */
const LOCK_STALE_MS = 120_000;
/**
 * How long a lock with no readable owner is presumed live before being reclaimed.
 *
 * Defence in depth: `tryAcquire` writes the record in full before the lock
 * exists, so an unidentifiable holder should be unreachable short of the
 * filesystem losing a completed write. The branch stays because the alternatives
 * are both worse — never reclaiming such a lock wedges the build, and reclaiming
 * instantly hands out a second concurrent generate if it turns out to be live
 * after all.
 */
const LOCK_OWNER_GRACE_MS = 2_000;
const POLL_INTERVAL_MS = 100;

/**
 * A waiter has to outlive the staleness threshold, or it gives up before the
 * lock it is waiting on can ever be reclaimed.
 */
function assertReclaimIsReachable(staleMs, timeoutMs) {
  if (staleMs < timeoutMs) return;

  throw new Error(
    `prisma-generate lock is misconfigured: staleMs (${staleMs}) must be below timeoutMs (${timeoutMs}), ` +
      'otherwise a waiter times out before it can reclaim the lock it is waiting on.',
  );
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function defaultSleep(ms) {
  // Synchronous by design: this runs before any generate work, and a blocking
  // wait keeps the whole script a straight line with no unhandled-rejection
  // paths around the lock.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sameHolder(a, b) {
  if (a === null || b === null) return a === b;
  return a.pid === b.pid && a.acquiredAt === b.acquiredAt;
}

function createLock({
  lockPath,
  now = Date.now,
  processAlive = defaultProcessAlive,
  sleep = defaultSleep,
  timeoutMs = LOCK_TIMEOUT_MS,
  staleMs = LOCK_STALE_MS,
  graceMs = LOCK_OWNER_GRACE_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  pid = process.pid,
}) {
  assertReclaimIsReachable(staleMs, timeoutMs);

  /** Distinguishes this process's staging files from any other racer's. */
  let scratch = 0;
  /** The record we published, for as long as we believe we still hold the lock. */
  let held = null;

  /**
   * The current holder and the lock's mtime, or null when the lock is free.
   *
   * One guarded read against one descriptor: a lock that goes away while being
   * inspected is the outcome a waiter is waiting for, not an error worth failing
   * the run over. Reading the owner and stat-ing the path separately is what let
   * a benign release surface as an ENOENT crash.
   */
  function read() {
    let raw;
    let stat;

    try {
      const fd = fs.openSync(lockPath, 'r');
      try {
        stat = fs.fstatSync(fd);
        raw = fs.readFileSync(fd, 'utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }

    let owner = null;
    try {
      owner = JSON.parse(raw);
    } catch {
      // Torn or half-written. Somebody holds it, but not identifiably; the
      // grace period runs off the mtime instead.
    }

    return { owner, mtimeMs: stat.mtimeMs };
  }

  function inspect() {
    const current = read();
    return current === null ? null : current.owner;
  }

  /**
   * A staging file holding a complete record, ready to become the lock.
   *
   * A process killed between the write and the `link`/`rename` that consumes it
   * leaks its staging file. That is deliberate: sweeping other processes' staging
   * files would delete a record whose owner is about to link it, turning a
   * successful acquire into an ENOENT crash. The files are inert, and they live
   * under `node_modules/.cache/`.
   */
  function stage() {
    const record = { pid, acquiredAt: now() };
    const stagingPath = `${lockPath}.${pid}.${scratch++}`;

    fs.writeFileSync(stagingPath, JSON.stringify(record));

    return { record, stagingPath };
  }

  function tryAcquire() {
    const { record, stagingPath } = stage();

    try {
      fs.linkSync(stagingPath, lockPath);
    } catch (error) {
      if (error.code === 'EEXIST') return false;
      throw error;
    } finally {
      fs.rmSync(stagingPath, { force: true });
    }

    held = record;

    return true;
  }

  function holderIsStale(observed) {
    if (observed.owner === null) return now() - observed.mtimeMs > graceMs;

    return !processAlive(observed.owner.pid) || now() - observed.owner.acquiredAt > staleMs;
  }

  /**
   * Free the lock if its holder is stale. Returns whether it was freed.
   *
   * The confirming read exists so a lock that changed hands since the staleness
   * decision is left alone, and it sits immediately before the rename with
   * nothing between the two calls.
   */
  function freeIfStale() {
    const observed = read();
    if (observed === null || !holderIsStale(observed)) return false;

    const confirmed = read();
    if (confirmed === null || !sameHolder(confirmed.owner, observed.owner)) return false;

    const quarantinePath = `${lockPath}.stale.${pid}.${scratch++}`;

    try {
      fs.renameSync(lockPath, quarantinePath);
    } catch (error) {
      // Another waiter freed it first, or the holder released. Either way it is
      // not ours to move; re-poll.
      if (error.code === 'ENOENT') return false;
      throw error;
    }

    fs.rmSync(quarantinePath, { force: true });

    return true;
  }

  function acquire() {
    const deadline = now() + timeoutMs;

    while (!tryAcquire()) {
      if (now() > deadline) {
        const holder = inspect();

        throw new Error(
          `Timed out after ${timeoutMs}ms waiting for another prisma generate to finish` +
            `${holder === null ? '' : ` (held by pid ${holder.pid})`}. ` +
            `If nothing is running, remove ${lockPath}.`,
        );
      }

      // Freeing a stale lock does not grant it: go straight back to `tryAcquire`
      // and compete for it, rather than sleeping first.
      if (!freeIfStale()) sleep(pollIntervalMs);
    }
  }

  function release() {
    if (held === null) return false;

    const record = held;
    held = null;

    // Only remove a lock we still hold. A run that outlived the staleness
    // threshold was taken over while it worked, and the lock now belongs to its
    // successor — removing that would hand a third process a concurrent
    // generate, the exact collision this lock exists to prevent.
    //
    // Residual window, knowingly left: our lock could be taken over between this
    // read and the removal below. That is two adjacent syscalls, against the
    // whole of a successor's runtime if the check were absent. Closing it needs a
    // compare-and-swap the filesystem does not offer.
    const current = read();
    if (current === null || !sameHolder(current.owner, record)) return false;

    fs.rmSync(lockPath, { force: true });

    return true;
  }

  return { acquire, release, inspect };
}

module.exports = {
  LOCK_TIMEOUT_MS,
  LOCK_STALE_MS,
  createLock,
};
