import { createServer, type AddressInfo, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  attemptWithin,
  describeHolder,
  LockConnectionTimeoutError,
  LockNotAcquiredError,
  PgAdvisoryLock,
} from './advisory-lock';
import type { BootstrapLogger } from './ports';

// The lock itself needs Postgres and is exercised in apps/api-e2e. What can be
// pinned without a database is how an attempt is cut to the deadline, how a
// holder is named, and that connecting, and an attempt nobody answers, give up
// inside the budget.

const silent: BootstrapLogger = { log: () => undefined, warn: () => undefined };

/** The backend's half of a startup that asks for no password: AuthenticationOk, then ReadyForQuery (idle). */
const STARTUP_ANSWERED = Buffer.from([0x52, 0, 0, 0, 8, 0, 0, 0, 0, 0x5a, 0, 0, 0, 5, 0x49]);

/** A local TCP server; `onConnection` decides what each socket hears. */
async function fakeDatabase(onConnection: (socket: Socket) => void) {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `postgres://bge:bge@127.0.0.1:${port}/bge`,
    connections: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

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
      const database = await fakeDatabase(() => undefined);
      const lock = new PgAdvisoryLock({
        connectionString: database.url,
        logger: silent,
        applicationName: 'bge-bootstrap:test',
      });

      try {
        const started = performance.now();
        await expect(lock.acquire({ deadlineAt: started + 300 })).rejects.toBeInstanceOf(LockConnectionTimeoutError);
        expect(performance.now() - started).toBeLessThan(2_000);
      } finally {
        await lock.close();
        await database.close();
      }
    });
  });

  describe('an attempt the database does not answer', () => {
    it('is abandoned with its connection, tried again on a new one, and given up at the deadline', async () => {
      // The startup is answered and nothing after it, as from a connection
      // pooler with no server connection free: the attempt waits in its queue,
      // and lock_timeout, which runs on the server, never starts.
      const database = await fakeDatabase((socket) => socket.once('data', () => socket.write(STARTUP_ANSWERED)));
      const lines: string[] = [];
      const lock = new PgAdvisoryLock({
        connectionString: database.url,
        logger: { log: (message) => void lines.push(message), warn: (message) => void lines.push(message) },
        applicationName: 'bge-bootstrap:test',
        attemptMs: 100,
        attemptGraceMs: 100,
      });

      try {
        const started = performance.now();
        const run = lock.acquire({ deadlineAt: started + 500 });

        await expect(run).rejects.toBeInstanceOf(LockNotAcquiredError);
        await expect(run).rejects.toThrow(/did not answer the last attempt, as when a connection pooler has no server/);
        expect(performance.now() - started).toBeLessThan(2_000);
        expect(database.connections()).toBeGreaterThan(1);
        expect(lines.some((line) => /trying again on a new connection/.test(line))).toBe(true);
      } finally {
        await lock.close();
        await database.close();
      }
    });
  });
});
