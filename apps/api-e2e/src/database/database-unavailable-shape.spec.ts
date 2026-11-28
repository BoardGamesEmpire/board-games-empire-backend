import { isDatabaseUnavailableError, Prisma, PrismaClient } from '@bge/database';
import { PrismaPg } from '@prisma/adapter-pg';
import { lookup } from 'node:dns/promises';
import type { Server, Socket } from 'node:net';
import { connect, createServer } from 'node:net';
import { Duplex } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { inspect } from 'node:util';
import type { PoolConfig } from 'pg';
import { Pool } from 'pg';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase, requireDatabaseUrl } from '../support/test-db';

/**
 * Pins the payloads a database outage produces, against a real database.
 *
 * ## Why this file exists
 *
 * `isDatabaseUnavailableError` decides whether a failure answers 503
 * `DATABASE_UNAVAILABLE` or an uncoded 500 (#1172). An outage doesn't arrive in
 * one shape, and two of them carry no Prisma code at all. Observed on
 * `@prisma/client@7.10.1` + `@prisma/adapter-pg@7.10.1` + `pg@8.23.1`, Postgres 17:
 *
 * - connection refused at a host's only address → P1001, cause kind
 *   `DatabaseNotReachable`; the same for a host name that doesn't resolve;
 * - connection refused at every address of a host name → a
 *   `PrismaClientKnownRequestError` whose `code` is Node's `ECONNREFUSED`, with
 *   no driver error under `meta`: Node raises an `AggregateError` with no
 *   `syscall`, which the adapter doesn't map;
 * - a socket error the adapter never maps (`EHOSTUNREACH`, a host with no
 *   route) → a `PrismaClientKnownRequestError` whose `code` is Node's, with no
 *   driver error under `meta`;
 * - a server that accepts the connection and never answers → P2028, "Unable
 *   to start a transaction in the given time", for an interactive transaction
 *   once `maxWait` passes (the pool has no connect timeout, #447);
 * - a server that resets the connection before answering → P1017, cause kind
 *   `ConnectionClosed`; one that closes it cleanly → a plain `Error`,
 *   "Connection terminated unexpectedly", no code;
 * - the backend ended mid-statement → P2039 for a model statement and P2010
 *   for a raw one, SQLSTATE 57P01 at `meta.driverAdapterError.cause`;
 * - the socket dropped mid-statement → a plain `Error`, "Connection terminated
 *   unexpectedly", no code;
 * - the backend ended while its transaction waited, then the next statement in
 *   it → a plain `Error`, "Client has encountered a connection error and is
 *   not queryable", no code.
 *
 * None of them is a `PrismaClientInitializationError`: `$connect()` resolves
 * with the server down, and the first query fails instead.
 *
 * After each, the next query on the same pool reconnects and succeeds.
 *
 * A unit test can only assert against a fabricated payload, so this keeps the
 * outage fixtures in `@bge/database/testing` honest, as `deadlock-shape.spec.ts`
 * does for the deadlock's.
 *
 * These assertions are CHARACTERIZATION. Going red is not necessarily a
 * defect, but it must be a decision rather than a drift, so each failure
 * prints the observed payload.
 *
 * ## Plumbing
 *
 * Each case opens its own client, built the way `DatabaseService` builds its
 * own, so ending its connections can't touch the shared client or the API
 * child's. Its connections carry an `application_name`, so a case ends only
 * its own backends.
 */

const describePayload = (error: unknown): string => inspect(error, { depth: null, showHidden: true, getters: true });

/** Rendered as a string so a failure prints the payload it couldn't classify. */
const classified = (error: unknown): string =>
  isDatabaseUnavailableError(error) ? 'classified' : `unclassified: ${describePayload(error)}`;

const rejectionOf = (pending: Promise<unknown>): Promise<unknown> =>
  pending.then(
    (value) => {
      throw new Error(`expected a rejection, got ${describePayload(value)}`);
    },
    (error: unknown) => error,
  );

interface DriverCause {
  readonly kind?: unknown;
  readonly originalCode?: unknown;
}

const driverCauseOf = (error: unknown): DriverCause | undefined =>
  (error as { meta?: { driverAdapterError?: { cause?: DriverCause } } }).meta?.driverAdapterError?.cause;

const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
  });

const close = (server: Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

describe('the shape of a database outage', () => {
  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  /** A client of its own on the harness database, its URL edited first. */
  const withClient = async (edit: (url: URL) => void, run: (client: PrismaClient) => Promise<void>): Promise<void> => {
    const url = new URL(requireDatabaseUrl());
    edit(url);
    const own = createTestDatabase(url.toString());

    try {
      await run(own.client);
    } finally {
      await own.close().catch(() => undefined);
    }
  };

  /** A client of its own whose pool also takes `config`, for what a URL can't say. */
  const withPool = async (config: PoolConfig, run: (client: PrismaClient) => Promise<void>): Promise<void> => {
    const pool = new Pool({ connectionString: requireDatabaseUrl(), ...config });
    pool.on('error', () => undefined);
    const client = new PrismaClient({ adapter: new PrismaPg(pool) });

    try {
      await run(client);
    } finally {
      await client.$disconnect().catch(() => undefined);
      await pool.end().catch(() => undefined);
    }
  };

  /** Waits until a backend of `applicationName` is running a statement, or waiting on a lock in one. */
  const untilActive = async (applicationName: string): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await db.client.$queryRaw<{ pid: number }[]>`
        SELECT pid FROM pg_stat_activity WHERE application_name = ${applicationName} AND state = 'active'`;

      if (rows.length > 0) {
        return;
      }

      await sleep(50);
    }

    throw new Error(`no active backend for ${applicationName}`);
  };

  const terminate = (applicationName: string, state: string): Promise<unknown> =>
    db.client.$queryRaw`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = ${applicationName} AND state = ${state}`;

  describe('a server that refuses the connection (#1172)', () => {
    it("arrives as P1001 at a host's only address", async () => {
      await withClient(
        (url) => {
          url.hostname = '127.0.0.1';
          url.port = '1';
        },
        async (client) => {
          const error = await rejectionOf(client.user.count());

          expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
          expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P1001');
          expect(driverCauseOf(error)?.kind).toBe('DatabaseNotReachable');
          expect(classified(error)).toBe('classified');
        },
      );
    });

    // Why a PrismaClientInitializationError isn't an outage: with a driver
    // adapter the client connects on its first query, so a server that's
    // down never fails initialisation.
    it('lets $connect() resolve, and fails the first query instead', async () => {
      await withClient(
        (url) => {
          url.hostname = '127.0.0.1';
          url.port = '1';
        },
        async (client) => {
          await expect(client.$connect()).resolves.toBeUndefined();

          const error = await rejectionOf(client.user.count());

          expect(error).not.toBeInstanceOf(Prisma.PrismaClientInitializationError);
          expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P1001');
        },
      );
    });

    // Node tries each address and raises an AggregateError when all refuse,
    // which the adapter rethrows unmapped. `localhost` resolves to one address
    // or two depending on the machine, so the expected shape follows it.
    it("arrives under Node's ECONNREFUSED when every address of the host refuses", async () => {
      const addresses = await lookup('localhost', { all: true });

      await withClient(
        (url) => {
          url.hostname = 'localhost';
          url.port = '1';
        },
        async (client) => {
          const error = await rejectionOf(client.user.count());

          expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
          expect((error as Prisma.PrismaClientKnownRequestError).code).toBe(
            addresses.length > 1 ? 'ECONNREFUSED' : 'P1001',
          );
          expect(classified(error)).toBe('classified');
        },
      );
    });
  });

  it('a host name that does not resolve arrives as P1001 (#1172)', async () => {
    await withClient(
      (url) => {
        url.hostname = 'bge-no-such-host.invalid';
      },
      async (client) => {
        const error = await rejectionOf(client.user.count());

        expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P1001');
        expect(driverCauseOf(error)?.kind).toBe('DatabaseNotReachable');
        expect(classified(error)).toBe('classified');
      },
    );
  });

  // A host with no route can't be arranged on a runner, so the socket is one
  // whose connect fails with the error Node raises for it. What this pins is
  // what the adapter and Prisma make of that error.
  it("a socket error the adapter never maps arrives under Node's code (#1172)", async () => {
    const unreachable = (): Duplex => {
      const socket = new Duplex({
        read: () => undefined,
        write: (_chunk, _encoding, done) => done(),
      });

      return Object.assign(socket, {
        setNoDelay: () => socket,
        setKeepAlive: () => socket,
        connect: () => {
          process.nextTick(() =>
            socket.emit(
              'error',
              Object.assign(new Error('connect EHOSTUNREACH 10.0.0.9:5432'), {
                errno: -65,
                code: 'EHOSTUNREACH',
                syscall: 'connect',
                address: '10.0.0.9',
                port: 5432,
              }),
            ),
          );
          return socket;
        },
      });
    };

    await withPool({ stream: unreachable as unknown as PoolConfig['stream'] }, async (client) => {
      const error = await rejectionOf(client.user.count());

      expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('EHOSTUNREACH');
      expect(driverCauseOf(error)).toBeUndefined();
      expect(classified(error)).toBe('classified');
    });
  });

  it('a server that never answers fails an interactive transaction with P2028 once maxWait passes (#1172)', async () => {
    const held: Socket[] = [];
    const server = createServer((socket) => held.push(socket));
    const port = await listen(server);

    try {
      await withClient(
        (url) => {
          url.hostname = '127.0.0.1';
          url.port = String(port);
        },
        async (client) => {
          try {
            // Prisma's default maxWait is 2 s; a shorter one keeps the case
            // quick and raises the same error.
            const error = await rejectionOf(client.$transaction(async (tx) => tx.user.count(), { maxWait: 250 }));

            expect(error).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
            expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2028');
            expect((error as Error).message).toBe(
              'Transaction API error: Unable to start a transaction in the given time.',
            );
            expect(classified(error)).toBe('classified');
          } finally {
            // The pending connect ends only when its socket does, and the
            // pool's end() waits for it. Destroyed here, before withClient
            // closes the client, so a failed assertion fails the case rather
            // than hanging it until Jest's timeout (#1172).
            held.forEach((socket) => socket.destroy());
          }
        },
      );
    } finally {
      held.forEach((socket) => socket.destroy());
      await close(server);
    }
  });

  // Both servers read the startup message before they hang up. A socket closed
  // with that message still unread resets on macOS but closes cleanly on Linux,
  // so a server that hangs up on accept pins whichever the platform picked
  // (#1172).
  it('a server that resets the connection before answering arrives as P1017 (#1172)', async () => {
    const server = createServer((socket) => socket.once('data', () => socket.resetAndDestroy()));
    const port = await listen(server);

    try {
      await withClient(
        (url) => {
          url.hostname = '127.0.0.1';
          url.port = String(port);
        },
        async (client) => {
          const error = await rejectionOf(client.user.count());

          expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P1017');
          expect(driverCauseOf(error)?.kind).toBe('ConnectionClosed');
          expect(classified(error)).toBe('classified');
        },
      );
    } finally {
      await close(server);
    }
  });

  it("a server that closes the connection cleanly before answering arrives as node-postgres's codeless error (#1172)", async () => {
    const server = createServer((socket) => socket.once('data', () => socket.end()));
    const port = await listen(server);

    try {
      await withClient(
        (url) => {
          url.hostname = '127.0.0.1';
          url.port = String(port);
        },
        async (client) => {
          const error = await rejectionOf(client.user.count());

          expect(error).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
          expect((error as Error).message).toBe('Connection terminated unexpectedly');
          expect((error as { code?: unknown }).code).toBeUndefined();
          expect(classified(error)).toBe('classified');
        },
      );
    } finally {
      await close(server);
    }
  });

  it("a connection dropped mid-statement arrives as node-postgres's codeless error, and the pool recovers (#1172)", async () => {
    // A TCP relay to the database, so the test can cut the socket under a
    // running statement as a network failure would.
    const target = new URL(requireDatabaseUrl());
    const sockets: Socket[] = [];
    const relay = createServer((inbound) => {
      const outbound = connect(Number(target.port), target.hostname);
      sockets.push(inbound, outbound);
      inbound.on('error', () => undefined);
      outbound.on('error', () => undefined);
      inbound.pipe(outbound).pipe(inbound);
    });
    const port = await listen(relay);

    try {
      await withClient(
        (url) => {
          url.hostname = '127.0.0.1';
          url.port = String(port);
          url.searchParams.set('application_name', 'bge-outage-dropped');
        },
        async (client) => {
          const running = rejectionOf(client.$queryRaw`SELECT pg_sleep(5)`);
          await untilActive('bge-outage-dropped');
          sockets.forEach((socket) => socket.destroy());
          const error = await running;

          expect(error).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
          expect((error as Error).message).toBe('Connection terminated unexpectedly');
          expect((error as { code?: unknown }).code).toBeUndefined();
          expect(classified(error)).toBe('classified');

          await expect(client.user.count()).resolves.toBe(0);
        },
      );
    } finally {
      sockets.forEach((socket) => socket.destroy());
      await close(relay);
    }
  });

  describe('a backend ended mid-statement (#1172)', () => {
    it('arrives as P2010 with 57P01 under a raw statement', async () => {
      await withClient(
        (url) => url.searchParams.set('application_name', 'bge-outage-raw'),
        async (client) => {
          const running = rejectionOf(client.$queryRaw`SELECT pg_sleep(5)`);
          await untilActive('bge-outage-raw');
          await terminate('bge-outage-raw', 'active');
          const error = await running;

          expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2010');
          expect(driverCauseOf(error)?.originalCode).toBe('57P01');
          expect(classified(error)).toBe('classified');
        },
      );
    });

    it("arrives as P2039, Prisma's generic database error, with 57P01 under a model statement", async () => {
      const user = await db.client.user.create({ data: { username: 'outage-a', email: 'outage-a@example.test' } });

      await withClient(
        (url) => url.searchParams.set('application_name', 'bge-outage-model'),
        async (client) => {
          // The shared client holds the row, so the model write waits on it
          // and is still running when its backend is ended.
          const locked = gate();
          const released = gate();
          const holder = db.client.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
            locked.open();
            await released.promise;
          });

          try {
            await locked.promise;
            const running = rejectionOf(client.user.update({ where: { id: user.id }, data: { username: 'outage-b' } }));
            await untilActive('bge-outage-model');
            await terminate('bge-outage-model', 'active');
            const error = await running;

            expect((error as Prisma.PrismaClientKnownRequestError).code).toBe('P2039');
            expect(driverCauseOf(error)?.originalCode).toBe('57P01');
            expect(classified(error)).toBe('classified');
          } finally {
            released.open();
            await holder;
          }
        },
      );
    });
  });

  it("a backend ended while its transaction waited fails the next statement with node-postgres's codeless error, and the pool recovers (#1172)", async () => {
    await withClient(
      (url) => url.searchParams.set('application_name', 'bge-outage-idle'),
      async (client) => {
        const error = await rejectionOf(
          client.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT 1`;
            await terminate('bge-outage-idle', 'idle in transaction');
            // The client hears of the ended backend asynchronously.
            await sleep(200);
            return tx.user.count();
          }),
        );

        expect(error).not.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
        expect((error as Error).message).toBe('Client has encountered a connection error and is not queryable');
        expect((error as { code?: unknown }).code).toBeUndefined();
        expect(classified(error)).toBe('classified');

        await expect(client.user.count()).resolves.toBe(0);
      },
    );
  });
});

/** A promise opened by name, so the write starts only once the row is held. */
function gate(): { open: () => void; promise: Promise<void> } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
}
