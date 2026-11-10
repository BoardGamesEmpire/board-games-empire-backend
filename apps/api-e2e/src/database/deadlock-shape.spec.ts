import { DEADLOCK_SQLSTATE, isDeadlockError, Prisma } from '@bge/database';
import { inspect } from 'node:util';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * Pins the payload a real deadlock produces, against a real database.
 *
 * ## Why this file exists
 *
 * `isDeadlockError` decides whether a failure is retryable and whether the edge
 * renders a typed 409 or a bare 500 (#398). It accepts Prisma's own P2034 and
 * otherwise reads SQLSTATE out of the driver adapter's `cause` — not public
 * Prisma API — because a deadlock does not arrive in one shape. On
 * `@prisma/client@7.10` + `@prisma/adapter-pg@7.10`:
 *
 * - losing statement raw → `PrismaClientKnownRequestError` (P2010), driver error
 *   under `meta.driverAdapterError`;
 * - losing statement an ordinary model write → `PrismaClientKnownRequestError`
 *   (P2034), driver error under `meta.driverAdapterError`.
 *
 * Up to 7.8 the adapter had no mapped `kind` for 40P01, so the model-write case
 * escaped as the bare `DriverAdapterError` with no Prisma class and no Prisma
 * `code`. That is the shape #398's production case produced, and why the untyped
 * 500 existed: nothing in the tree recognised it. `isDeadlockError` still reads
 * that position, so a regression to it stays classified. A unit test can
 * only assert against a fabricated payload, so this is what keeps the fixtures
 * in `@bge/database/testing` honest — the same relationship
 * `p2002-shape.spec.ts` has with the unique-violation fixtures.
 *
 * These assertions are CHARACTERIZATION. Going red is not necessarily a defect,
 * but it must be a decision rather than a drift, so each failure prints the
 * observed payload.
 *
 * ## Plumbing
 *
 * Two interactive transactions take two row locks in opposite orders, gated so
 * the interleaving is deterministic rather than hoped for. `createTestDatabase`
 * builds its client the way `DatabaseService` builds its own (explicit `pg` Pool
 * plus `PrismaPg`), so this observes the shape the application observes.
 */

const describePayload = (error: unknown): string => inspect(error, { depth: null, showHidden: true, getters: true });

/** A promise resolved by name, so each transaction can wait for the other's first lock. */
const gate = (): { promise: Promise<void>; open: () => void } => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });

  return { promise, open };
};

describe('the shape of a Postgres deadlock', () => {
  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    await db.close();
  });

  /** Two rows to contend over. Re-arranged per test: the sweep truncates between tests (#255). */
  const arrangePair = async (): Promise<{ firstId: string; secondId: string }> => {
    const first = await db.client.user.create({ data: { username: 'deadlock-a', email: 'deadlock-a@example.test' } });
    const second = await db.client.user.create({ data: { username: 'deadlock-b', email: 'deadlock-b@example.test' } });

    return { firstId: first.id, secondId: second.id };
  };

  /**
   * Runs two transactions into a cycle and returns the victim. Postgres chooses
   * which one dies, so the caller is handed whichever lost — never told which.
   */
  const raceToDeadlock = async (
    take: (tx: Prisma.TransactionClient, id: string) => Promise<unknown>,
  ): Promise<unknown> => {
    const { firstId, secondId } = await arrangePair();
    const firstTaken = gate();
    const secondTaken = gate();

    const outcomes = await Promise.allSettled([
      db.client.$transaction(async (tx) => {
        await take(tx, firstId);
        firstTaken.open();
        await secondTaken.promise;
        await take(tx, secondId);
      }),
      db.client.$transaction(async (tx) => {
        await take(tx, secondId);
        secondTaken.open();
        await firstTaken.promise;
        await take(tx, firstId);
      }),
    ]);

    const rejected = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected');

    // Exactly one victim, and never which one: Postgres picks. Two victims would
    // mean this raced something other than the cycle it was built to race.
    expect(rejected).toHaveLength(1);

    return rejected[0].reason;
  };

  const lockRaw = (tx: Prisma.TransactionClient, id: string): Promise<unknown> =>
    tx.$queryRaw`SELECT id FROM users WHERE id = ${id} FOR UPDATE`;

  const writeThroughPrisma = (tx: Prisma.TransactionClient, id: string): Promise<unknown> =>
    tx.user.update({ where: { id }, data: { username: `touched-${id.slice(0, 6)}` } });

  describe('when the losing statement is an ordinary model write', () => {
    it("arrives as P2034, Prisma's own code for a write conflict or deadlock", async () => {
      const victim = await raceToDeadlock(writeThroughPrisma);

      // Up to 7.8 this escaped as a bare DriverAdapterError, which is what made
      // #398's 500 untyped. 7.10's adapter maps 40P01 to `TransactionWriteConflict`
      // and the client wraps it as P2034. If it stops, say so deliberately.
      expect(victim).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((victim as Prisma.PrismaClientKnownRequestError).code).toBe('P2034');

      const meta = (victim as Prisma.PrismaClientKnownRequestError).meta as {
        driverAdapterError?: { cause?: { originalCode?: unknown; kind?: unknown } };
      };

      expect(meta.driverAdapterError?.cause?.originalCode).toBe(DEADLOCK_SQLSTATE);
      expect(meta.driverAdapterError?.cause?.kind).toBe('TransactionWriteConflict');
    });

    it('is classified as a deadlock', async () => {
      const victim = await raceToDeadlock(writeThroughPrisma);

      // The assertion the retry and the 409 both rest on. Rendered as a string
      // so a failure prints the payload it could not classify — whoever sees
      // this red needs the shape, not the word `false`.
      expect(isDeadlockError(victim) ? 'classified' : `unclassified: ${describePayload(victim)}`).toBe('classified');
    });
  });

  describe('when the losing statement is raw', () => {
    it('arrives as P2010 with the driver error under meta', async () => {
      const victim = await raceToDeadlock(lockRaw);

      expect(victim).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((victim as Prisma.PrismaClientKnownRequestError).code).toBe('P2010');

      const meta = (victim as Prisma.PrismaClientKnownRequestError).meta as {
        driverAdapterError?: { cause?: { originalCode?: unknown; kind?: unknown } };
      };

      expect(meta.driverAdapterError?.cause?.originalCode).toBe(DEADLOCK_SQLSTATE);
      // A mapped kind since 7.10; 7.8 passed 40P01 through as `kind: 'postgres'`
      // with the raw pg fields alongside. The raw path keeps P2010 either way:
      // a raw query's failure is P2010 whatever its kind.
      expect(meta.driverAdapterError?.cause?.kind).toBe('TransactionWriteConflict');
    });

    it('is classified as a deadlock', async () => {
      const victim = await raceToDeadlock(lockRaw);

      expect(isDeadlockError(victim) ? 'classified' : `unclassified: ${describePayload(victim)}`).toBe('classified');
    });
  });

  it("keeps Postgres's own wording in the payload", async () => {
    const victim = await raceToDeadlock(writeThroughPrisma);

    // P2034's message is Prisma's "write conflict or a deadlock", which does not
    // say which. The driver's message does, and it is what an operator reading
    // the log needs.
    expect(describePayload(victim)).toContain('deadlock detected');
  });
});
