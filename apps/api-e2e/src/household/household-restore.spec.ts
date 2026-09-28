import { InviteStatus, InviteType, ResourceType, SystemRole } from '@bge/database';
import { createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createEnvelope, deleteEnvelope, listEnvelope } from './household-wire';

/**
 * Restoring a soft-deleted household (#175), against the running server.
 *
 * What the unit suite cannot show is the mechanism end to end: the delete
 * writes real `UserPermission` rows, the ability loader picks them up on the
 * next request, `@casl/prisma` turns their `{ deletedAt: { not: null } }`
 * condition into the restore's `where`, and the loader's expiry filter is what
 * closes the window. Every case here goes through all of it.
 */
describe('household restore (#175)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const HOUSEHOLDS_PATH = '/api/households';

  /** The window `deleteHousehold` issues. Restated, since this suite is black-box. */
  const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

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

  const restore = (actor: SessionActor, id: string) =>
    request(baseUrl).post(`${HOUSEHOLDS_PATH}/${id}/restore`).set(actor.headers);

  const read = (actor: SessionActor, id: string) => request(baseUrl).get(`${HOUSEHOLDS_PATH}/${id}`).set(actor.headers);

  const deletedAt = async (id: string): Promise<Date | null> =>
    (await db.client.household.findUniqueOrThrow({ where: { id }, select: { deletedAt: true } })).deletedAt;

  /** The recovery grants on a household, as the ability loader will read them. */
  const recoveryGrants = (householdId: string) =>
    db.client.userPermission.findMany({
      where: { resourceType: ResourceType.Household, resourceId: householdId },
      select: { userId: true, grantedById: true, expiresAt: true, permission: { select: { slug: true } } },
      orderBy: { userId: 'asc' },
    });

  it('lets an owner undo their delete, bringing the household and its roster back as they were', async () => {
    const owner = await actors.user();
    const member = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Deleted by mistake',
      members: [{ actor: member, role: SystemRole.HouseholdMember }],
    });
    const id = fixture.household.id;

    const before = Date.now();
    const deleted = deleteEnvelope(await remove(owner, id).expect(200), 'DELETE /api/households/:id');
    const after = Date.now();

    // The deadline a client shows next to its undo.
    expect(deleted.restorableUntil).not.toBeNull();
    const until = Date.parse(deleted.restorableUntil ?? '');
    expect(until).toBeGreaterThanOrEqual(before + RESTORE_WINDOW_MS);
    expect(until).toBeLessThanOrEqual(after + RESTORE_WINDOW_MS);

    await expect(recoveryGrants(id)).resolves.toEqual([
      {
        userId: owner.user.id,
        grantedById: owner.user.id,
        expiresAt: new Date(until),
        permission: { slug: 'update:household:restore' },
      },
    ]);

    const restored = createEnvelope(await restore(owner, id).expect(200), 'POST /api/households/:id/restore');

    expect(restored.household.id).toBe(id);
    expect(restored.household.deletedAt).toBeNull();
    await expect(deletedAt(id)).resolves.toBeNull();

    // The window was for this delete, so it closes with it.
    await expect(recoveryGrants(id)).resolves.toEqual([]);

    // Every member is back, not only the restorer: their household grants
    // returned, and each graph was evicted so it sees them now.
    await read(owner, id).expect(200);
    await read(member, id).expect(200);
    expect(
      listEnvelope(
        await request(baseUrl).get(HOUSEHOLDS_PATH).set(member.headers).expect(200),
        'GET /api/households',
      ).households.map((household) => household.id),
    ).toEqual([id]);

    await expect(db.client.householdMember.count({ where: { householdId: id } })).resolves.toBe(2);
    await request(baseUrl).patch(`${HOUSEHOLDS_PATH}/${id}`).set(owner.headers).send({ name: 'Back' }).expect(200);
  });

  it('gives every owner the window, so a co-owner can undo a delete they did not make', async () => {
    const deleter = await actors.user();
    const coOwner = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner: deleter,
      name: 'Two owners',
      members: [{ actor: coOwner, role: SystemRole.HouseholdOwner }],
    });
    const id = fixture.household.id;

    await remove(deleter, id).expect(200);

    const grants = await recoveryGrants(id);
    expect(grants.map(({ userId }) => userId).sort()).toEqual([deleter.user.id, coOwner.user.id].sort());
    expect(grants.every(({ grantedById }) => grantedById === deleter.user.id)).toBe(true);

    await restore(coOwner, id).expect(200);

    // The deleter's grant goes too, although someone else restored.
    await expect(recoveryGrants(id)).resolves.toEqual([]);
    await expect(deletedAt(id)).resolves.toBeNull();
  });

  it('answers 404 to anyone the window was not given to, and restores nothing', async () => {
    const owner = await actors.user();
    const member = await actors.user();
    const stranger = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Owners only',
      members: [{ actor: member, role: SystemRole.HouseholdMember }],
    });
    const id = fixture.household.id;

    await remove(owner, id).expect(200);

    // A plain member and a stranger get the same answer, so neither learns
    // more than the other.
    await restore(member, id).expect(404);
    await restore(stranger, id).expect(404);

    await expect(deletedAt(id)).resolves.not.toBeNull();
  });

  it('answers 404 once the window has passed, even to an owner with no other household', async () => {
    // The owner's only household is the deleted one, so they hold no `update`
    // rule on Household once the grant lapses. The route's guard asks for
    // `read`, which every user holds, so the answer is the service's 404 and
    // not a 403 from the guard.
    const owner = await actors.user();
    const fixture = await actors.householdWithMembers({ owner, name: 'Too late' });
    const id = fixture.household.id;

    await remove(owner, id).expect(200);

    // Aged in place. The delete evicted the owner's cached graph and nothing
    // has rebuilt it since, so the next request reads this row fresh, and the
    // loader drops it as expired.
    await db.client.userPermission.updateMany({
      where: { resourceType: ResourceType.Household, resourceId: id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await restore(owner, id).expect(404);
    await expect(deletedAt(id)).resolves.not.toBeNull();
  });

  it('answers 409 to a reader retrying a restore that landed, and 404 to a stranger asking the same', async () => {
    const owner = await actors.user();
    const member = await actors.user();
    const stranger = await actors.user();

    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Restored already',
      members: [{ actor: member, role: SystemRole.HouseholdMember }],
    });
    const id = fixture.household.id;

    await remove(owner, id).expect(200);
    await restore(owner, id).expect(200);

    // The offline queue's retry of a restore whose response was lost.
    await restore(owner, id).expect(409);
    await restore(member, id).expect(409);

    // Read-scoped: someone who cannot see the household learns nothing.
    await restore(stranger, id).expect(404);
  });

  it('answers 404 for an id that never existed', async () => {
    const actor = await actors.user();

    await restore(actor, `missing-${randomUUID()}`).expect(404);
  });

  it('leaves the invites the delete revoked revoked', async () => {
    const owner = await actors.user();
    const fixture = await actors.householdWithMembers({ owner, name: 'Invites stay revoked' });
    const id = fixture.household.id;

    const invite = await db.client.invite.create({
      data: {
        type: InviteType.Household,
        status: InviteStatus.Pending,
        inviterId: owner.user.id,
        householdId: id,
        inviteeEmail: `invitee-${randomUUID()}@e2e.invalid`,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
      },
      select: { id: true },
    });

    await remove(owner, id).expect(200);
    await restore(owner, id).expect(200);

    // A token that went dead with the household does not come back to life
    // with it; the inviter sends a new one.
    await expect(
      db.client.invite.findUniqueOrThrow({ where: { id: invite.id }, select: { status: true } }),
    ).resolves.toEqual({ status: InviteStatus.Revoked });
  });

  it('lets an operator’s denial of the restore stand, pinned or not, and offers the denied no undo', async () => {
    const owner = await actors.user();
    const coOwner = await actors.user();
    const admin = await actors.admin();

    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Operator says no',
      members: [{ actor: coOwner, role: SystemRole.HouseholdOwner }],
    });
    const id = fixture.household.id;
    const { id: permissionId } = await db.client.permission.findUniqueOrThrow({
      where: { slug: 'update:household:restore' },
      select: { id: true },
    });

    // Arranged as an operator would: the deleter is denied the restore on
    // every household, the co-owner on this one.
    const denial = { permissionId, resourceType: ResourceType.Household, inverted: true, grantedById: admin.user.id };
    await db.client.userPermission.createMany({
      data: [
        { ...denial, userId: owner.user.id, resourceId: null },
        { ...denial, userId: coOwner.user.id, resourceId: id },
      ],
    });

    const keyRows = () =>
      db.client.userPermission.findMany({
        where: { permissionId, userId: { in: [owner.user.id, coOwner.user.id] } },
        select: { userId: true, resourceId: true, inverted: true, grantedById: true, expiresAt: true },
      });

    const deleted = deleteEnvelope(await remove(owner, id).expect(200), 'DELETE /api/households/:id');

    // The delete still writes the deleter a grant, but the loader applies
    // denials last, so the unpinned one outranks it: no undo to offer.
    expect(deleted.restorableUntil).toBeNull();

    const afterDelete = await keyRows();
    expect(afterDelete).toHaveLength(3);
    expect(afterDelete).toEqual(
      expect.arrayContaining([
        { userId: owner.user.id, resourceId: null, inverted: true, grantedById: admin.user.id, expiresAt: null },
        expect.objectContaining({ userId: owner.user.id, resourceId: id, inverted: null, grantedById: owner.user.id }),
        // The co-owner's denial is exactly as set: not re-dated, not
        // re-attributed, not turned into a grant.
        { userId: coOwner.user.id, resourceId: id, inverted: true, grantedById: admin.user.id, expiresAt: null },
      ]),
    );

    await restore(owner, id).expect(404);
    await restore(coOwner, id).expect(404);
    await expect(deletedAt(id)).resolves.not.toBeNull();

    // A staff restore revokes the grant and leaves both denials.
    await restore(admin, id).expect(200);

    const afterRestore = await keyRows();
    expect(afterRestore).toHaveLength(2);
    expect(afterRestore).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: owner.user.id, resourceId: null, inverted: true }),
        expect.objectContaining({ userId: coOwner.user.id, resourceId: id, inverted: true }),
      ]),
    );
  });

  it('issues no window on a staff delete, so its owners cannot undo moderation', async () => {
    const owner = await actors.user();
    const admin = await actors.admin();
    const fixture = await actors.householdWithMembers({ owner, name: 'Moderated' });
    const id = fixture.household.id;

    const deleted = deleteEnvelope(await remove(admin, id).expect(200), 'DELETE /api/households/:id (staff)');

    expect(deleted.restorableUntil).toBeNull();
    await expect(recoveryGrants(id)).resolves.toEqual([]);

    await restore(owner, id).expect(404);
    await expect(deletedAt(id)).resolves.not.toBeNull();
  });
});
