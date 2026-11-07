import { Prisma, type DatabaseService } from '@bge/database';
import { createMockDatabaseService, rawQueryText, type MockDatabaseService } from '@bge/testing';
import { ExtendedNetworkService, REBUILD_ALL_BATCH_SIZE } from './extended-network.service';

/**
 * The statement itself runs against a real database in
 * `apps/api-e2e/src/friendship/extended-network.spec.ts`. These pin what a mock
 * can see: the lock, the order, the transaction it all runs in, and the
 * counts it reports.
 */
describe('ExtendedNetworkService (#497)', () => {
  let db: MockDatabaseService;
  let service: ExtendedNetworkService;

  beforeEach(() => {
    db = createMockDatabaseService();
    db.$transaction.mockImplementation(async (fn) => fn(db));
    db.$queryRaw.mockResolvedValue([{ removed: 2n, written: 5n }] as never);
    service = new ExtendedNetworkService(db as unknown as DatabaseService);
  });

  const lockCall = () => db.$executeRaw.mock.calls[0]?.[0] as Prisma.Sql;
  const statementCall = () => db.$queryRaw.mock.calls[0]?.[0] as Prisma.Sql;

  it.each([
    ['rebuildAround', () => service.rebuildAround('user-1')],
    ['rebuildAllBatch', () => service.rebuildAllBatch(null)],
  ] as const)(
    '%s takes the extended network table lock, then writes in one statement, and reports the counts as numbers (#497)',
    async (_name, rebuild) => {
      await expect(rebuild()).resolves.toEqual(expect.objectContaining({ removed: 2, written: 5 }));

      expect(db.$transaction).toHaveBeenCalledTimes(1);
      expect(rawQueryText(lockCall())).toBe('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))');
      expect(lockCall().values).toEqual(['extended-network']);
      expect(db.$queryRaw).toHaveBeenCalledTimes(1);
      expect(db.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(db.$queryRaw.mock.invocationCallOrder[0]);
    },
  );

  // Under the lock, a later rebuild's statement reads the friendships only
  // after the earlier one committed, so it never writes an older state over a
  // newer one. That holds only if each statement takes its own snapshot, as
  // under Read Committed. Under Repeatable Read the snapshot would be taken
  // at the lock, before the wait. The timeout covers a rebuild around a user
  // with hundreds of friends, which walks from most of a large server and
  // takes longer than Prisma's default.
  it.each([
    ['rebuildAround', () => service.rebuildAround('user-1')],
    ['rebuildAllBatch', () => service.rebuildAllBatch(null)],
  ] as const)('%s runs Read Committed, with time to wait for another rebuild (#497)', async (_name, rebuild) => {
    await rebuild();

    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 10 * 60 * 1000,
    });
  });

  it('binds the statement to the user it rebuilds around (#497)', async () => {
    await service.rebuildAround('user-1');

    expect(statementCall().values).toEqual(['user-1']);
  });

  // Measured on #497: at 30 friends a user, two index lookups on friendships
  // per user per step made most of a rebuild. Reading the accepted friendships
  // once, into a list the walk joins by hash, halved it for the same rows.
  it.each([
    ['rebuildAround', () => service.rebuildAround('user-1')],
    ['rebuildAllBatch', () => service.rebuildAllBatch(null)],
  ] as const)(
    '%s walks a list of the accepted friendships read once, not an index lookup per user per step (#497)',
    async (_name, rebuild) => {
      await rebuild();

      const sql = rawQueryText(statementCall());
      expect(sql).toContain('adj(a, other) AS MATERIALIZED');
      expect(sql).not.toContain('LATERAL');
    },
  );

  // A full rebuild runs in batches of users, each its own transaction, so a
  // change's rebuild waits for one batch at most, not the whole run. Every
  // user is a source, so a user left with no friendship loses their rows.
  it('rebuilds from the first users by id, the batch size at a time, binding nothing (#497)', async () => {
    await service.rebuildAllBatch(null);

    const sql = rawQueryText(statementCall());
    expect(statementCall().values).toEqual([]);
    expect(sql).toMatch(new RegExp(`FROM users u\\s+ORDER BY u\\.id LIMIT ${REBUILD_ALL_BATCH_SIZE}\\b`));
    expect(sql).toContain('un.user_id IN (SELECT user_id FROM sources)');
  });

  it('starts a later batch after the user the last one ended on (#497)', async () => {
    await service.rebuildAllBatch('user-9');

    expect(statementCall().values).toEqual(['user-9']);
    expect(rawQueryText(statementCall())).toMatch(/FROM users u WHERE u\.id > \? ORDER BY u\.id/);
  });

  it('names the batch’s last user as the next start while a full batch was taken (#497)', async () => {
    db.$queryRaw.mockResolvedValue([
      { removed: 1n, written: 3n, last_user_id: 'user-200', sources: BigInt(REBUILD_ALL_BATCH_SIZE) },
    ] as never);

    await expect(service.rebuildAllBatch(null)).resolves.toEqual({ removed: 1, written: 3, next: 'user-200' });
  });

  // A batch short of the size reached the last user, so no empty batch runs
  // after it.
  it.each([
    ['a short batch', { last_user_id: 'user-7', sources: 7n }],
    ['an empty one', { last_user_id: null, sources: 0n }],
  ])('names no next start after %s (#497)', async (_case, row) => {
    db.$queryRaw.mockResolvedValue([{ removed: 0n, written: 0n, ...row }] as never);

    await expect(service.rebuildAllBatch('user-1')).resolves.toEqual({ removed: 0, written: 0, next: null });
  });

  it('reports only the counts for a rebuild around a user (#497)', async () => {
    await expect(service.rebuildAround('user-1')).resolves.toEqual({ removed: 2, written: 5 });
  });
});
