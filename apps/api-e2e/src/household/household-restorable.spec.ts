import { ResourceType, SystemRole } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { mintApiKey, type Caller } from '../support/api-key';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { deleteEnvelope, listEnvelope, restorableListEnvelope } from './household-wire';

/**
 * Listing the deleted households the acting user can restore (#542), against
 * the running server.
 *
 * The list must agree with `POST /households/:id/restore`: a household is
 * listed only when the route would restore it for the same actor, and for a
 * household owner whenever it would. Staff are the exception on purpose: they
 * can restore any deleted household, and none is listed for them (#419). So
 * the cases pair the two where they can, and each goes through the real grants
 * a delete writes and the ability loader that reads them.
 */
describe('restorable households (#542)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const HOUSEHOLDS_PATH = '/api/households';
  const RESTORABLE_PATH = `${HOUSEHOLDS_PATH}/restorable`;
  const RESTORE_SLUG = 'update:household:restore';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const remove = (actor: SessionActor, id: string) =>
    request(baseUrl).delete(`${HOUSEHOLDS_PATH}/${id}`).set(actor.headers);

  const restore = (caller: Caller, id: string) =>
    request(baseUrl).post(`${HOUSEHOLDS_PATH}/${id}/restore`).set(caller.headers);

  const restorable = async (caller: Caller, query = '') =>
    restorableListEnvelope(
      await request(baseUrl).get(`${RESTORABLE_PATH}${query}`).set(caller.headers).expect(200),
      'GET /api/households/restorable',
    );

  const restorableIds = async (caller: Caller) =>
    (await restorable(caller)).households.map((household) => household.id);

  it('lists a deleted household to each of its household owners, with when their window ends', async () => {
    const deleter = await actors.user();
    const coOwner = await actors.user();
    const member = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner: deleter,
      name: 'Deleted on the phone',
      members: [
        { actor: coOwner, role: SystemRole.HouseholdOwner },
        { actor: member, role: SystemRole.HouseholdMember },
      ],
    });
    const id = fixture.household.id;

    const deleted = deleteEnvelope(await remove(deleter, id).expect(200), 'DELETE /api/households/:id');
    expect(deleted.restorableUntil).not.toBeNull();

    for (const owner of [deleter, coOwner]) {
      const { households, pagination } = await restorable(owner);

      expect(households.map((household) => household.id)).toEqual([id]);
      expect(pagination.total).toBe(1);

      const [household] = households;
      // Every household owner's grant ends together, at the deadline DELETE
      // answered.
      expect(household.restorableUntil).toBe(deleted.restorableUntil);
      expect(household.deletedAt).not.toBeNull();
      // The roster as it stood at the delete, which is how a household owner on
      // another device recognises the household.
      expect(household.members.map((entry) => entry.userId).sort()).toEqual(
        [deleter.user.id, coOwner.user.id, member.user.id].sort(),
      );
    }
  });

  it('still leaves a deleted household out of the household list', async () => {
    const owner = await actors.user();
    const fixture = await actors.householdWithMembers({ owner, name: 'Only on the restorable list' });
    const id = fixture.household.id;

    await remove(owner, id).expect(200);

    expect(await restorableIds(owner)).toEqual([id]);
    expect(
      listEnvelope(
        await request(baseUrl).get(HOUSEHOLDS_PATH).set(owner.headers).expect(200),
        'GET /api/households',
      ).households.map((household) => household.id),
    ).not.toContain(id);
  });

  it('drops a household once the acting user’s window has ended, as the restore route refuses it', async () => {
    // The household owner's only household is the deleted one, so once their
    // grant lapses they hold no `update` rule on Household at all. The answer
    // is still an empty page, not a 403.
    const owner = await actors.user();
    const coOwner = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Window closes',
      members: [{ actor: coOwner, role: SystemRole.HouseholdOwner }],
    });
    const id = fixture.household.id;

    await remove(owner, id).expect(200);

    // Aged in place, this household owner's grant alone. The delete evicted
    // their cached graph and nothing has rebuilt it since, so the next request
    // reads this row fresh, and the loader drops it as expired.
    await db.client.userPermission.updateMany({
      where: { resourceType: ResourceType.Household, resourceId: id, userId: owner.user.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    expect(await restorableIds(owner)).toEqual([]);
    await restore(owner, id).expect(404);

    // The other household owner's window is still open.
    expect(await restorableIds(coOwner)).toEqual([id]);
  });

  it('answers a null restorableUntil for a window with no end date, which the restore route honours', async () => {
    const owner = await actors.user();
    const fixture = await actors.householdWithMembers({ owner, name: 'No deadline' });
    const id = fixture.household.id;

    await remove(owner, id).expect(200);

    // Arranged directly, as only an operator would: no route writes a grant
    // with no end date. As above, the next request reads this row fresh.
    await db.client.userPermission.updateMany({
      where: { resourceType: ResourceType.Household, resourceId: id, userId: owner.user.id },
      data: { expiresAt: null },
    });

    const { households } = await restorable(owner);
    expect(households.map((household) => household.id)).toEqual([id]);
    // Not DELETE's `null`, which means the delete opened no window.
    expect(households[0].restorableUntil).toBeNull();

    await restore(owner, id).expect(200);
  });

  it('drops a household once anyone restores it', async () => {
    const deleter = await actors.user();
    const coOwner = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner: deleter,
      name: 'Back again',
      members: [{ actor: coOwner, role: SystemRole.HouseholdOwner }],
    });
    const id = fixture.household.id;

    await remove(deleter, id).expect(200);
    expect(await restorableIds(deleter)).toEqual([id]);

    await restore(coOwner, id).expect(200);

    expect(await restorableIds(deleter)).toEqual([]);
    expect(await restorableIds(coOwner)).toEqual([]);
  });

  it('lists nothing to a member, a stranger, or staff who are not its household owners', async () => {
    const owner = await actors.user();
    const member = await actors.user();
    const stranger = await actors.user();
    const admin = await actors.admin();

    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Owners only',
      members: [{ actor: member, role: SystemRole.HouseholdMember }],
    });
    const id = fixture.household.id;

    await remove(owner, id).expect(200);

    expect(await restorableIds(member)).toEqual([]);
    expect(await restorableIds(stranger)).toEqual([]);
    expect(await restorableIds(admin)).toEqual([]);

    // Staff can restore it all the same. Their reach over deleted households
    // is the all-subject view, which this list does not answer (#419).
    await restore(admin, id).expect(200);
  });

  it('lists nothing to its household owners after a staff delete', async () => {
    const owner = await actors.user();
    const admin = await actors.admin();
    const fixture = await actors.householdWithMembers({ owner, name: 'Moderated' });
    const id = fixture.household.id;

    await remove(admin, id).expect(200);

    expect(await restorableIds(owner)).toEqual([]);
    await restore(owner, id).expect(404);
  });

  it('hides a household from a household owner denied the restore, pinned to it or not', async () => {
    const deleter = await actors.user();
    const pinnedDenied = await actors.user();
    const coOwner = await actors.user();
    const admin = await actors.admin();

    const fixture = await actors.householdWithMembers({
      owner: deleter,
      name: 'Denied the undo',
      members: [
        { actor: pinnedDenied, role: SystemRole.HouseholdOwner },
        { actor: coOwner, role: SystemRole.HouseholdOwner },
      ],
    });
    const id = fixture.household.id;
    const { id: permissionId } = await db.client.permission.findUniqueOrThrow({
      where: { slug: RESTORE_SLUG },
      select: { id: true },
    });

    // Arranged directly: no route writes a denial. The deleter is denied the
    // restore on every household, the second household owner on this one.
    const denial = { permissionId, resourceType: ResourceType.Household, inverted: true, grantedById: admin.user.id };
    await db.client.userPermission.createMany({
      data: [
        { ...denial, userId: deleter.user.id, resourceId: null },
        { ...denial, userId: pinnedDenied.user.id, resourceId: id },
      ],
    });

    await remove(deleter, id).expect(200);

    // The delete still wrote the deleter a grant pinned to this household,
    // but the denial outranks it, in the list as in the route.
    expect(await restorableIds(deleter)).toEqual([]);
    await restore(deleter, id).expect(404);

    expect(await restorableIds(pinnedDenied)).toEqual([]);
    await restore(pinnedDenied, id).expect(404);

    // A household owner nobody denied still sees it.
    expect(await restorableIds(coOwner)).toEqual([id]);
  });

  it('lists to an API key only when its key scopes also allow updating households', async () => {
    const owner = await actors.user();
    const fixture = await actors.householdWithMembers({ owner, name: 'Restored by a key' });
    const id = fixture.household.id;

    await remove(owner, id).expect(200);

    const scope = (slugs: readonly string[]) => ({ slugs, resourceType: ResourceType.Household });
    const readOnly = await mintApiKey(baseUrl, db.client, owner, scope(['read:households']));
    const updater = await mintApiKey(baseUrl, db.client, owner, scope(['read:households', 'update:household']));
    const restorer = await mintApiKey(baseUrl, db.client, owner, scope(['read:households', RESTORE_SLUG]));

    // Floored by its key scopes: what the key may not restore, it does not see.
    expect(await restorableIds(readOnly)).toEqual([]);
    await restore(readOnly, id).expect(404);

    // Any `update` scope on Household will do, not only the restore slug: a key
    // scope carries none of its permission's conditions, so the key owner's
    // restore grant is what picks the household.
    expect(await restorableIds(updater)).toEqual([id]);

    expect(await restorableIds(restorer)).toEqual([id]);
    await restore(restorer, id).expect(200);
  });

  it('pages newest household first, over the shared envelope', async () => {
    const owner = await actors.user();
    const older = await actors.householdWithMembers({ owner, name: 'Created first' });
    const newer = await actors.householdWithMembers({ owner, name: 'Created second' });

    // Dated apart: two creates in a row can share a millisecond, and the tie
    // would then fall to the id.
    await db.client.household.update({
      where: { id: older.household.id },
      data: { createdAt: new Date(Date.now() - 60_000) },
    });

    await remove(owner, older.household.id).expect(200);
    await remove(owner, newer.household.id).expect(200);

    const first = await restorable(owner, '?limit=1');
    expect(first.households.map((household) => household.id)).toEqual([newer.household.id]);
    expect(first.pagination).toEqual({ page: 1, limit: 1, total: 2, totalPages: 2, hasMore: true });

    const second = await restorable(owner, '?page=2&limit=1');
    expect(second.households.map((household) => household.id)).toEqual([older.household.id]);
  });
});
