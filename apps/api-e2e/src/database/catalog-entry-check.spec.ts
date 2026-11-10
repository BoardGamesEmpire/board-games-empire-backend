import type { PermissionSeedDefinition } from '@bge/database';
import { PERMISSION_CATALOG, Prisma, probeConditions, ResourceType } from '@bge/database';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

/**
 * The entry check's probe against a real database (#772).
 *
 * An edited condition is judged by Prisma itself: rendered with sample values
 * and run as the `where` of a count on the permission's resource type. Only a
 * real client shows what Prisma accepts, and only Postgres shows that a refused
 * probe leaves the caller's transaction usable, which matters because the
 * probe runs inside the start's reconcile and inside the Owner's edit.
 *
 * DB-only, like `catalog-reconcile.spec.ts`: no HTTP. Nothing here writes:
 * every probe is a count, run in a transaction, so the harness database is left
 * as it was.
 */

type Probed = Pick<PermissionSeedDefinition, 'slug' | 'subject' | 'conditions'>;

/**
 * A value Prisma passes and Postgres refuses: `minPlayers` is an `integer`
 * column, and Prisma does not check the range. Postgres answers with an error
 * that aborts the transaction it runs in.
 */
const OUT_OF_RANGE = { minPlayers: 4_000_000_000 };

describe('the entry check probe against Postgres', () => {
  let db: TestDatabase;

  beforeAll(() => {
    db = createTestDatabase();
  });

  afterAll(async () => {
    // A leaked pool keeps Jest alive.
    await db.close();
  });

  const probe = (permission: Probed) => db.client.$transaction((tx) => probeConditions(tx, permission));

  it('Prisma rejects an unknown field before it reaches the database (#772)', async () => {
    // The gate the probe rests on: Prisma's own validation refuses the field,
    // so no statement reaches Postgres. `visibility` is the column #808 renamed
    // to `reach`, the case an edit made before an upgrade runs into.
    await expect(db.client.game.count({ where: { visibility: 'Public' } as never })).rejects.toBeInstanceOf(
      Prisma.PrismaClientValidationError,
    );

    expect(
      await probe({ slug: 'read:game', subject: ResourceType.Game, conditions: { visibility: 'Public' } }),
    ).toEqual([
      { kind: 'query-rejected', slug: 'read:game', message: expect.stringContaining('Unknown argument `visibility`') },
    ]);
  });

  it('rejects an operator in the wrong place (#772)', async () => {
    // `some` filters a list relation; `title` is a scalar.
    expect(await probe({ slug: 'read:game', subject: ResourceType.Game, conditions: { title: { some: {} } } })).toEqual(
      [{ kind: 'query-rejected', slug: 'read:game', message: expect.stringContaining('Unknown argument `some`') }],
    );
  });

  it('rejects a placeholder in an enum column, which renders to a value the enum lacks (#772)', async () => {
    expect(
      await probe({ slug: 'read:game', subject: ResourceType.Game, conditions: { reach: '{{ user.id }}' } }),
    ).toEqual([{ kind: 'query-rejected', slug: 'read:game', message: expect.stringContaining('Expected Reach') }]);
  });

  it('rejects a value Postgres refuses though Prisma passes it (#772)', async () => {
    expect(await probe({ slug: 'read:game', subject: ResourceType.Game, conditions: OUT_OF_RANGE })).toEqual([
      { kind: 'query-rejected', slug: 'read:game', message: expect.stringContaining('out of range for type integer') },
    ]);
  });

  it('passes every shipped condition (#772)', async () => {
    const problems = await db.client.$transaction(
      async (tx) => {
        const found = [];
        for (const permission of PERMISSION_CATALOG) {
          found.push(...(await probeConditions(tx, permission)));
        }
        return found;
      },
      { timeout: 60_000 },
    );

    expect(problems).toEqual([]);
  });

  it('refuses a condition on a resource type with no model (#772)', async () => {
    expect(await probe({ slug: 'read:public_content', subject: 'all', conditions: { id: 'x' } })).toEqual([
      { kind: 'subject-has-no-model', slug: 'read:public_content', subject: 'all' },
    ]);
  });

  it("leaves the caller's transaction usable after Postgres refuses a probe (#772)", async () => {
    // The probe runs inside the start's reconcile and the Owner's edit, which
    // go on after a refusal. Its savepoint is what lets them.
    const after = await db.client.$transaction(async (tx) => {
      const refused = await probeConditions(tx, {
        slug: 'read:game',
        subject: ResourceType.Game,
        conditions: OUT_OF_RANGE,
      });
      return { refused, permissions: await tx.permission.count() };
    });

    expect(after.refused).toHaveLength(1);
    expect(after.permissions).toBeGreaterThan(0);
  });

  it("rejects a NUL byte, which Postgres refuses as data, in Postgres's words, and leaves the transaction usable (#772)", async () => {
    // Prisma passes the string, and Postgres refuses it with SQLSTATE 22021.
    // The pg adapter has no name for that code, so since Prisma 7.10 it
    // reaches the probe as P2039 with the driver error under meta (up to 7.8
    // it was the bare driver error). It is a verdict on the condition, not a
    // 500, and the Owner is shown Postgres's line, not Prisma's wrapper.
    const after = await db.client.$transaction(async (tx) => {
      const refused = await probeConditions(tx, {
        slug: 'read:game',
        subject: ResourceType.Game,
        conditions: { title: 'a\u0000b' },
      });
      return { refused, permissions: await tx.permission.count() };
    });

    expect(after.refused).toEqual([
      { kind: 'query-rejected', slug: 'read:game', message: 'invalid byte sequence for encoding "UTF8": 0x00' },
    ]);
    expect(after.permissions).toBeGreaterThan(0);
  });

  it('needs its savepoint: without one, the same refusal aborts the transaction (#772)', async () => {
    // The control for the test above, so that one cannot pass because the
    // refusal never reached Postgres.
    await expect(
      db.client.$transaction(async (tx) => {
        await tx.game.count({ where: OUT_OF_RANGE }).catch(() => undefined);
        return tx.permission.count();
      }),
    ).rejects.toThrow(/current transaction is aborted/);
  });
});
