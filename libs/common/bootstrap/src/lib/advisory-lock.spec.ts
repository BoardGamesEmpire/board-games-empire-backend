import { createServer, type AddressInfo, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { attemptWithin, describeHolder, LockConnectionTimeoutError, PgAdvisoryLock } from './advisory-lock';
import type { BootstrapLogger } from './ports';

// The lock itself needs Postgres and is exercised in apps/api-e2e. What can be
// pinned without a database is how an attempt is cut to the deadline, how a
// holder is named, and that connecting gives up inside the budget.

const silent: BootstrapLogger = { log: () => undefined, warn: () => undefined };

describe('the advisory lock', () => {
  describe('attemptWithin', () => {
    it('is the full attempt while more than that is left', () => {
      expect(attemptWithin(5_000, 12_000)).toBe(5_000);
      expect(attemptWithin(5_000, Infinity)).toBe(5_000);
    });

    it('is cut to what is left, in whole milliseconds, which is what lock_timeout accepts', () => {
      expect(attemptWithin(5_000, 300)).toBe(300);
      expect(attemptWithin(5_000, 2.7)).toBe(2);
    });

    it('is never shorter than one millisecond, so a free lock is still taken at or past the deadline', () => {
      expect(attemptWithin(5_000, 0.4)).toBe(1);
      expect(attemptWithin(5_000, 0)).toBe(1);
      expect(attemptWithin(5_000, -1_000)).toBe(1);
    });
  });

  describe('describeHolder', () => {
    it('is undefined when nobody holds the lock', () => {
      expect(describeHolder([])).toBeUndefined();
    });

    it('names a holder by pid, application name and state', () => {
      expect(describeHolder([{ pid: 42, application_name: 'bge-bootstrap:api', state: 'idle' }])).toBe(
        'pid 42 (bge-bootstrap:api, idle)',
      );
    });

    it('falls back for a holder without a name or state, and lists several', () => {
      expect(
        describeHolder([
          { pid: 7, application_name: '', state: null },
          { pid: 9, application_name: 'psql', state: 'active' },
        ]),
      ).toBe('pid 7 (unnamed), pid 9 (psql, active)');
    });
  });

  describe('connecting', () => {
    it('gives up inside the sequence deadline when the database accepts the connection and never answers', async () => {
      // A socket that accepts and stays silent: a black-holed endpoint, a proxy
      // with nothing behind it. node-postgres alone would wait on it forever.
      const sockets = new Set<Socket>();
      const server = createServer((socket) => void sockets.add(socket));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      const lock = new PgAdvisoryLock({
        connectionString: `postgres://bge:bge@127.0.0.1:${port}/bge`,
        logger: silent,
        applicationName: 'bge-bootstrap:test',
      });

      try {
        const started = performance.now();
        await expect(lock.acquire({ deadlineAt: started + 300 })).rejects.toBeInstanceOf(LockConnectionTimeoutError);
        expect(performance.now() - started).toBeLessThan(2_000);
      } finally {
        await lock.close();
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  });
});
