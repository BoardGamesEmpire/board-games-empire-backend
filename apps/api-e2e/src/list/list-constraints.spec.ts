import { ListKind, type Prisma } from '@bge/database';
import { createActors, type Actors } from '@bge/testing-e2e';
import { inspect } from 'node:util';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { arrangeGame, arrangeList, arrangePlatformGame, findWishlist } from './list-fixtures';

/**
 * The database half of #1241: what a list and its entries may hold, asserted
 * against a REAL database because the rules live in a hand-written migration
 * (`20261114120000_lists_and_wishlist`). Prisma cannot model a CHECK constraint
 * or a partial unique index, so no generated type or unit test knows they
 * exist. This file makes their absence loud, and pins the names the list
 * service and its specs refer to.
 *
 * Rows are arranged directly: the constraints have to hold whatever path
 * inserts.
 */

/** A rejected write names its constraint somewhere in the error; the shape varies by constraint kind. */
async function rejection(operation: () => Promise<unknown>, what: string): Promise<string> {
  try {
    await operation();
  } catch (error) {
    return inspect(error, { depth: null, showHidden: true, getters: true });
  }

  throw new Error(`Expected ${what} to be refused, but nothing threw. The constraint is missing from the schema.`);
}

describe('list constraints (#1241)', () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const arrangeOwner = async () => (await actors.user()).user.id;

  const entryData = (listId: string, target: Partial<Prisma.ListEntryUncheckedCreateInput>) => ({
    data: { listId, ...target },
  });

  it('refuses an entry naming both a game and a platform game, or neither (#1241)', async () => {
    const list = await arrangeList(db.client, await arrangeOwner());
    const { gameId, platformGameId } = await arrangePlatformGame(db.client);

    await expect(
      rejection(
        () => db.client.listEntry.create(entryData(list.id, { gameId, platformGameId })),
        'an entry naming a game and a platform game',
      ),
    ).resolves.toContain('list_entries_one_target');

    await expect(
      rejection(() => db.client.listEntry.create(entryData(list.id, {})), 'an entry naming neither'),
    ).resolves.toContain('list_entries_one_target');
  });

  it('refuses a release on an entry that names a game rather than a platform game (#1241)', async () => {
    const list = await arrangeList(db.client, await arrangeOwner());
    const { gameId, platformGameId } = await arrangePlatformGame(db.client);
    const release = await db.client.gameRelease.create({
      data: { platformGameId, editionKey: 'e2e-edition' },
      select: { id: true },
    });

    // Asserts the trigger's message, not the CHECK's name: the BEFORE trigger
    // inherited from `game_lists` fires first. The CHECK is a backstop, pinned
    // by name in the last test.
    await expect(
      rejection(
        () => db.client.listEntry.create(entryData(list.id, { gameId, releaseId: release.id })),
        'a release on a game entry',
      ),
    ).resolves.toContain('set without platform_game_id');

    await expect(
      db.client.listEntry.create(entryData(list.id, { platformGameId, releaseId: release.id })),
    ).resolves.toMatchObject({ releaseId: release.id });
  });

  it('refuses a second wishlist for one user, and allows any number of custom lists (#1241)', async () => {
    const ownerId = await arrangeOwner();

    // Provisioning made this owner's wishlist, the first one (#1241).
    await findWishlist(db.client, ownerId);

    await expect(
      rejection(() => arrangeList(db.client, ownerId, { kind: ListKind.Wishlist }), 'a second wishlist'),
    ).resolves.toContain('lists_one_wishlist_per_user');

    await arrangeList(db.client, ownerId);
    await arrangeList(db.client, ownerId);

    await expect(db.client.list.count({ where: { userId: ownerId, kind: ListKind.Custom } })).resolves.toBe(2);

    // Another user's provisioned wishlist is not a second one.
    const otherId = await arrangeOwner();

    await expect(findWishlist(db.client, otherId)).resolves.toMatchObject({ userId: otherId });
  });

  it('refuses a custom list with no name, and keeps a wishlist with none (#1241)', async () => {
    const ownerId = await arrangeOwner();

    await expect(
      rejection(() => arrangeList(db.client, ownerId, { name: null }), 'a custom list with no name'),
    ).resolves.toContain('lists_custom_needs_name');

    // The owner's provisioned wishlist is unnamed; a second wishlist can't be arranged.
    await expect(findWishlist(db.client, ownerId)).resolves.toMatchObject({ kind: ListKind.Wishlist, name: null });
  });

  it('refuses the same game or platform game twice in one list, and allows it in another (#1241)', async () => {
    const ownerId = await arrangeOwner();
    const list = await arrangeList(db.client, ownerId);
    const other = await arrangeList(db.client, ownerId);
    const { gameId, platformGameId } = await arrangePlatformGame(db.client);

    await db.client.listEntry.create(entryData(list.id, { gameId }));
    await db.client.listEntry.create(entryData(list.id, { platformGameId }));

    await expect(
      rejection(() => db.client.listEntry.create(entryData(list.id, { gameId })), 'a game twice'),
    ).resolves.toContain('list_entries_list_id_game_id_key');
    await expect(
      rejection(() => db.client.listEntry.create(entryData(list.id, { platformGameId })), 'a platform game twice'),
    ).resolves.toContain('list_entries_list_id_platform_game_id_key');

    await expect(db.client.listEntry.create(entryData(other.id, { gameId }))).resolves.toMatchObject({ gameId });
  });

  it('takes a list entry with it when its game or its platform game is deleted (#1241)', async () => {
    const list = await arrangeList(db.client, await arrangeOwner());
    const byGame = await arrangeGame(db.client);
    const gameEntry = await db.client.listEntry.create(entryData(list.id, { gameId: byGame.id }));
    const { gameId, platformGameId } = await arrangePlatformGame(db.client);
    const platformEntry = await db.client.listEntry.create(entryData(list.id, { platformGameId }));

    // The platform game goes with its game, and its entry goes with it.
    await db.client.game.delete({ where: { id: gameId } });
    await db.client.game.delete({ where: { id: byGame.id } });

    await expect(db.client.listEntry.findUnique({ where: { id: gameEntry.id } })).resolves.toBeNull();
    await expect(db.client.listEntry.findUnique({ where: { id: platformEntry.id } })).resolves.toBeNull();
    await expect(db.client.list.findUnique({ where: { id: list.id } })).resolves.not.toBeNull();
  });

  it('lists the hand-written constraints by name (#1241)', async () => {
    const checks = await db.client.$queryRaw<{ name: string }[]>`
      SELECT conname::text AS name FROM pg_constraint
      WHERE contype = 'c' AND conrelid IN (to_regclass(${`${db.schema}.lists`}), to_regclass(${`${db.schema}.list_entries`}))
      ORDER BY conname
    `;
    const indexes = await db.client.$queryRaw<{ name: string; partial: boolean }[]>`
      SELECT i.relname::text AS name, ix.indpred IS NOT NULL AS partial
      FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid
      WHERE ix.indrelid = to_regclass(${`${db.schema}.lists`}) AND ix.indisunique AND NOT ix.indisprimary
    `;

    expect(checks.map((row) => row.name)).toEqual([
      'list_entries_one_target',
      'list_entries_release_needs_platform_game',
      'lists_custom_needs_name',
    ]);
    expect(indexes).toEqual([{ name: 'lists_one_wishlist_per_user', partial: true }]);
  });
});
