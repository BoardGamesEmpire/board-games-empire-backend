import { createServer, type AddressInfo, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import {
  attemptWithin,
  describeHolder,
  LockConnectionTimeoutError,
  LockLostError,
  LockNotAcquiredError,
  PgAdvisoryLock,
} from './advisory-lock';
import type { BootstrapLogger } from './ports';

// The lock's SQL needs Postgres and is exercised in apps/api-e2e. Here a fake
// database that speaks just enough of the protocol pins what the lock does
// with each answer: a lock another process holds, a step nobody answers, a
// connection that fails. Beside it, how an attempt is cut to the deadline and
// how a holder is named.

const silent: BootstrapLogger = { log: () => undefined, warn: () => undefined };

/** One backend message: its type, then a length that counts itself and the body. */
function backendMessage(type: string, body: Buffer = Buffer.alloc(0)): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'latin1');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

/** The backend's half of a startup that asks for no password: AuthenticationOk, then ReadyForQuery (idle). */
const STARTUP_ANSWERED = Buffer.concat([backendMessage('R', Buffer.alloc(4)), backendMessage('Z', Buffer.from('I'))]);

/** A statement's end, then ReadyForQuery in a transaction. */
const QUERY_ANSWERED = Buffer.concat([
  backendMessage('C', Buffer.from('SELECT 1\0')),
  backendMessage('Z', Buffer.from('T')),
]);

/** A FATAL error, as Postgres sends before it closes a connection it ends. */
const CONNECTION_ENDED = backendMessage(
  'E',
  Buffer.from('SFATAL\0VFATAL\0C57P01\0Mterminating connection due to administrator command\0\0'),
);

/** An attempt whose lock_timeout ran out, then ReadyForQuery in a failed transaction. */
const LOCK_TIMED_OUT = Buffer.concat([
  backendMessage('E', Buffer.from('SERROR\0VERROR\0C55P03\0Mcanceling statement due to lock timeout\0\0')),
  backendMessage('Z', Buffer.from('E')),
]);

interface Holder {
  pid: number;
  application_name: string;
  state: string;
}

/**
 * The answer to the read of the holder, at its Sync: ParseComplete,
 * BindComplete, the three columns, a row per holder, then the statement's end.
 */
function holdersAnswered(holders: readonly Holder[]): Buffer {
  const int16 = (value: number) => Buffer.from([value >> 8, value & 0xff]);
  const column = (name: string, typeOid: number, size: number) => {
    const meta = Buffer.alloc(18);
    meta.writeInt32BE(typeOid, 6);
    meta.writeInt16BE(size, 10);
    meta.writeInt32BE(-1, 12);
    return Buffer.concat([Buffer.from(`${name}\0`), meta]);
  };
  const value = (text: string) => {
    const length = Buffer.alloc(4);
    length.writeInt32BE(Buffer.byteLength(text));
    return Buffer.concat([length, Buffer.from(text)]);
  };
  const INT4 = 23;
  const TEXT = 25;

  return Buffer.concat([
    backendMessage('1'),
    backendMessage('2'),
    backendMessage(
      'T',
      Buffer.concat([
        int16(3),
        column('pid', INT4, 4),
        column('application_name', TEXT, -1),
        column('state', TEXT, -1),
      ]),
    ),
    ...holders.map((holder) =>
      backendMessage(
        'D',
        Buffer.concat([int16(3), value(String(holder.pid)), value(holder.application_name), value(holder.state)]),
      ),
    ),
    backendMessage('C', Buffer.from(`SELECT ${holders.length}\0`)),
    backendMessage('Z', Buffer.from('I')),
  ]);
}

/** Answers the startup, then hands each message after it to `onMessage`: its type, and its body as text. */
function serve(socket: Socket, onMessage: (type: string, text: string) => void): void {
  let started = false;
  let pending = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    // The startup message has no type byte, only its length.
    if (!started) {
      if (pending.length < 4 || pending.length < pending.readInt32BE(0)) return;
      pending = pending.subarray(pending.readInt32BE(0));
      started = true;
      socket.write(STARTUP_ANSWERED);
    }
    while (pending.length >= 5 && pending.length >= pending.readInt32BE(1) + 1) {
      const type = String.fromCharCode(pending[0]);
      const text = pending.subarray(5, pending.readInt32BE(1) + 1).toString();
      pending = pending.subarray(pending.readInt32BE(1) + 1);
      onMessage(type, text);
    }
  });
}

/**
 * Answers the startup and every query, until the first simple query whose text
 * includes `silentFrom`; nothing after it. With `last`, that query is answered
 * with `last`, in one write, and the connection closed. An extended query, the
 * read of the holder, is answered at its Sync, with nobody holding the lock.
 */
function answersUntil(silentFrom: string, last?: Buffer) {
  return (socket: Socket) => {
    let silent = false;
    serve(socket, (type, text) => {
      if (!silent && type === 'Q' && text.includes(silentFrom)) {
        silent = true;
        if (last) socket.end(last);
      }
      if (silent) return;
      if (type === 'Q') socket.write(QUERY_ANSWERED);
      if (type === 'S') socket.write(holdersAnswered([]));
    });
  };
}

/**
 * Another process holds the lock through the first `attempts` attempts, on any
 * connection: each waits out its lock_timeout and fails as Postgres's does,
 * and the read after it finds `holders`. Every later attempt is granted.
 */
function lockHeld(attempts: number, holders: readonly Holder[]) {
  let refused = 0;
  return (socket: Socket) =>
    serve(socket, (type, text) => {
      const lockTimeout = /lock_timeout = '(\d+)ms'/.exec(text);
      if (type === 'Q' && lockTimeout && refused < attempts) {
        refused += 1;
        setTimeout(() => {
          if (!socket.destroyed) socket.write(LOCK_TIMED_OUT);
        }, Number(lockTimeout[1]));
        return;
      }
      if (type === 'Q') socket.write(QUERY_ANSWERED);
      if (type === 'S') socket.write(holdersAnswered(holders));
    });
}

/** `onConnection`, but only `ms` after the connection opens: a database slow to answer the startup. */
function slowToStart(ms: number, onConnection: (socket: Socket) => void) {
  // Until a listener reads it, the startup message waits in the socket's buffer.
  return (socket: Socket) => void setTimeout(() => onConnection(socket), ms);
}

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
    /**
     * Writes `last` to each open connection and closes it. Settles once the
     * client has closed its side too, so it has read `last` by then.
     */
    end: async (last: Buffer) => {
      const open = [...sockets].filter((socket) => !socket.destroyed);
      await Promise.all(
        open.map((socket) => new Promise<void>((resolve) => socket.once('close', () => resolve()).end(last))),
      );
    },
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
        attemptGraceMs: 100,
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

    it('is given the grace at the deadline, so a free lock is still taken there', async () => {
      // A connection opened at the deadline: after an abandoned step, or after
      // the connection failed between acquires. Cut to the time left, it gave
      // up before its attempt, and the refusal named neither holder nor queue.
      const database = await fakeDatabase(slowToStart(50, answersUntil('COMMIT')));
      const lock = new PgAdvisoryLock({
        connectionString: database.url,
        logger: silent,
        applicationName: 'bge-bootstrap:test',
        attemptGraceMs: 500,
      });

      try {
        await expect(lock.acquire({ deadlineAt: performance.now() })).resolves.toBeUndefined();
      } finally {
        await lock.close();
        await database.close();
      }
    });
  });

  describe('a lock another process holds', () => {
    const HOLDER = { pid: 42, application_name: 'bge-bootstrap:api', state: 'idle in transaction' };

    it('is waited for with its holder named, and refused at the deadline', async () => {
      const database = await fakeDatabase(lockHeld(Infinity, [HOLDER]));
      const lines: string[] = [];
      const lock = new PgAdvisoryLock({
        connectionString: database.url,
        logger: { log: (message) => void lines.push(message), warn: (message) => void lines.push(message) },
        applicationName: 'bge-bootstrap:test',
        attemptMs: 100,
      });

      try {
        const run = lock.acquire({ deadlineAt: performance.now() + 500 });

        await expect(run).rejects.toBeInstanceOf(LockNotAcquiredError);
        await expect(run).rejects.toThrow(
          /\(held by pid 42 \(bge-bootstrap:api, idle in transaction\)\)\. Another process is still migrating or seeding/,
        );
        expect(lines[0]).toMatch(
          /^Waiting for the bootstrap lock held by pid 42 \(bge-bootstrap:api, idle in transaction\)/,
        );
        // As from a finally after the refusal: there is nothing to give back.
        await expect(lock.release()).resolves.toBeUndefined();
      } finally {
        await lock.close();
        await database.close();
      }
    });

    it('is taken once its holder lets it go, and released', async () => {
      // The holder finished between the attempt's timeout and the read of it.
      const database = await fakeDatabase(lockHeld(1, []));
      const lines: string[] = [];
      const lock = new PgAdvisoryLock({
        connectionString: database.url,
        logger: { log: (message) => void lines.push(message), warn: (message) => void lines.push(message) },
        applicationName: 'bge-bootstrap:test',
        attemptMs: 100,
      });

      try {
        await lock.acquire();

        expect(lines).toEqual([expect.stringMatching(/^Waiting for the bootstrap lock \(0s of \d+s\)\.$/)]);
        await expect(lock.release()).resolves.toBeUndefined();
        // A second release, as from a finally after the first, does nothing.
        await expect(lock.release()).resolves.toBeUndefined();
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

  describe('an attempt that fails for another reason', () => {
    it('fails the acquire with that error', async () => {
      // Postgres ends the connection while the attempt waits, as on a restart.
      const database = await fakeDatabase(answersUntil('pg_advisory_xact_lock', CONNECTION_ENDED));
      const lock = new PgAdvisoryLock({
        connectionString: database.url,
        logger: silent,
        applicationName: 'bge-bootstrap:test',
      });

      try {
        await expect(lock.acquire()).rejects.toThrow(/^terminating connection due to administrator command$/);
      } finally {
        await lock.close();
        await database.close();
      }
    });
  });

  describe('a connection that fails as the lock is granted', () => {
    it('refuses the acquire, since the lock ended with the connection', async () => {
      // The grant and the failure arrive in one read. node-postgres settles the
      // attempt, then reports the failure before the attempt's caller resumes.
      const database = await fakeDatabase(
        answersUntil('pg_advisory_xact_lock', Buffer.concat([QUERY_ANSWERED, CONNECTION_ENDED])),
      );
      const lock = new PgAdvisoryLock({
        connectionString: database.url,
        logger: silent,
        applicationName: 'bge-bootstrap:test',
      });

      try {
        await expect(lock.acquire()).rejects.toBeInstanceOf(LockLostError);
      } finally {
        await lock.close();
        await database.close();
      }
    });
  });

  describe('a connection that fails while the lock is held', () => {
    const LOST = /failed while it held the lock \(terminating connection due to administrator command\)/;

    it('is refused by the next check, which leaves the release nothing to give back', async () => {
      const database = await fakeDatabase(answersUntil('COMMIT'));
      const lock = new PgAdvisoryLock({
        connectionString: database.url,
        logger: silent,
        applicationName: 'bge-bootstrap:test',
      });

      try {
        await lock.acquire();
        expect(() => lock.assertHeld()).not.toThrow();

        await database.end(CONNECTION_ENDED);

        expect(() => lock.assertHeld()).toThrow(LOST);
        await expect(lock.release()).resolves.toBeUndefined();
      } finally {
        await lock.close();
        await database.close();
      }
    });

    it('is refused by the release when no check came after it', async () => {
      const database = await fakeDatabase(answersUntil('COMMIT'));
      const lock = new PgAdvisoryLock({
        connectionString: database.url,
        logger: silent,
        applicationName: 'bge-bootstrap:test',
      });

      try {
        await lock.acquire();
        await database.end(CONNECTION_ENDED);

        await expect(lock.release()).rejects.toThrow(LOST);
      } finally {
        await lock.close();
        await database.close();
      }
    });
  });

  describe('the COMMIT that releases the lock', () => {
    it('is given up when the database does not answer it, and the release refuses', async () => {
      // The lock is taken, then nothing more is answered: a connection that died
      // without a reset while its transaction sat idle, as when a load balancer
      // drops an idle connection. Unbounded, the COMMIT waits out TCP's retries.
      const database = await fakeDatabase(answersUntil('COMMIT'));
      const lock = new PgAdvisoryLock({
        connectionString: database.url,
        logger: silent,
        applicationName: 'bge-bootstrap:test',
        attemptGraceMs: 200,
      });

      try {
        await lock.acquire();
        const started = performance.now();
        await expect(lock.release()).rejects.toBeInstanceOf(LockLostError);
        expect(performance.now() - started).toBeLessThan(2_000);
      } finally {
        await lock.close();
        await database.close();
      }
    });

    it('refuses the release when it fails', async () => {
      const database = await fakeDatabase(answersUntil('COMMIT', CONNECTION_ENDED));
      const lock = new PgAdvisoryLock({
        connectionString: database.url,
        logger: silent,
        applicationName: 'bge-bootstrap:test',
      });

      try {
        await lock.acquire();
        await expect(lock.release()).rejects.toThrow(
          /failed while it held the lock \(terminating connection due to administrator command\)/,
        );
      } finally {
        await lock.close();
        await database.close();
      }
    });
  });
});
