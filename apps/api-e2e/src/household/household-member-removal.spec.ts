import { SystemRole, Visibility } from '@bge/database';
import {
  createActors,
  HOUSEHOLD_ROLE_NAMES,
  type Actors,
  type HouseholdRoleName,
  type SessionActor,
} from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { arrangeCollectionEntry } from '../game-collection/game-collection-fixtures';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createMemberClient } from './household-request';
import { memberEnvelope } from './household-wire';

/**
 * Removing a member and leaving a household, over HTTP (#273).
 *
 * Both routes end in one transaction: find the membership the caller may
 * reach, refuse the last owner, delete the membership's `ExcludedGame` rows,
 * its household role and then the membership itself, and evict the departing
 * user's cached permissions after commit. What each case here pins is a part of
 * that a unit spec with a mocked database cannot see: which rows actually go,
 * which stay, and what the departing user can do next.
 *
 * Covered elsewhere and not repeated: a removed member's next read is refused
 * (`household-read-after-write.spec.ts`, and `permissions/graph-cache-late-write.spec.ts`
 * for a stale graph written back), and both routes answer 404 for a deleted
 * household (`household-lifecycle.spec.ts`, `role-transition-tombstone.spec.ts`).
 * Staff removing a member is driven in `permissions/staff-grant-seeds.spec.ts`,
 * beside the rest of the staff grants.
 *
 * Every arrangement below, excluded games included, runs before any actor's
 * first authenticated request, per the ordering rule (#272). Every membership
 * change after that point goes through a route that evicts server-side.
 */
describe('removing household members and leaving households', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { removeMember, leave, transferOwnership } = createMemberClient(baseUrl);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  /** Test titles in the glossary's words rather than the role names. */
  const ROLE_LABEL: Readonly<Record<HouseholdRoleName, string>> = {
    [SystemRole.HouseholdOwner]: 'household owner',
    [SystemRole.HouseholdAdmin]: 'household admin',
    [SystemRole.HouseholdMember]: 'regular member',
    [SystemRole.HouseholdGuest]: 'household guest',
  };

  const readHousehold = (actor: SessionActor, householdId: string) =>
    request(baseUrl).get(`/api/households/${householdId}`).set(actor.headers);

  /** Every membership and its household role, so "unchanged" is a comparison rather than a count. */
  const roster = (householdId: string) =>
    db.client.householdMember.findMany({
      where: { householdId },
      select: { id: true, userId: true, role: { select: { role: { select: { name: true } } } } },
      orderBy: { id: 'asc' },
    });

  /**
   * Whether a membership and its household role are both gone. The role is
   * checked on its own because the schema declares no cascade: the service
   * deletes it explicitly, and a membership row missing while its role row
   * survives would be a different bug from the membership surviving.
   */
  const expectMembershipGone = async (memberId: string) => {
    await expect(db.client.householdMember.count({ where: { id: memberId } })).resolves.toBe(0);
    await expect(db.client.householdRole.count({ where: { householdMemberId: memberId } })).resolves.toBe(0);
  };

  /**
   * The two 403s removing a member can meet say different things, so a test can tell
   * which layer refused. The route guard refuses an actor holding no `manage`
   * on memberships at all; the service refuses one whose grant exists but
   * does not reach the membership named.
   */
  const REFUSED_BY_GUARD = 'You do not have permission to perform this action.';
  const REFUSED_BY_SERVICE = "You don't have permission to delete this resource.";

  const messageOf = (response: { body: unknown }): unknown => (response.body as { message?: unknown } | null)?.message;

  /** The last-owner refusal names the household and points at the way out of it. */
  const expectLastOwnerRefusal = (response: { status: number; body: unknown }, householdId: string) => {
    expect(response.status).toBe(400);

    const message = messageOf(response);
    expect(message).toEqual(expect.stringContaining(householdId));
    expect(message).toMatch(/transfer ownership/i);
  };

  it('seeds the leave permission on all four household roles', async () => {
    // Only the member role and the household guest role rely on it. A
    // household owner or admin also leaves through `manage:household_member`,
    // which CASL reads as covering `delete`, and the route's own `userId` pin
    // is what keeps that from reaching anyone else's membership.
    for (const roleName of HOUSEHOLD_ROLE_NAMES) {
      const role = await db.client.role.findUniqueOrThrow({
        where: { name: roleName },
        select: { permissions: { select: { permission: { select: { slug: true } } } } },
      });

      expect({ roleName, slugs: role.permissions.map((row) => row.permission.slug) }).toEqual({
        roleName,
        slugs: expect.arrayContaining(['delete:household_member:leave']),
      });
    }
  });

  describe('removing a member', () => {
    const REMOVERS = [SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin] as const;
    // No household owner among the targets. The only one a route can make is
    // the last owner, covered below; one the fixture could add is a co-owner,
    // and whether a household admin may remove a co-owner is still open
    // (#174). A case here would decide it.
    const TARGETS = [SystemRole.HouseholdMember, SystemRole.HouseholdGuest, SystemRole.HouseholdAdmin] as const;

    const removals = REMOVERS.flatMap((remover) =>
      TARGETS.map((target) => ({
        remover,
        target,
        removerLabel: ROLE_LABEL[remover],
        targetLabel: ROLE_LABEL[target],
      })),
    );

    it.each(removals)(
      'lets a $removerLabel remove a $targetLabel, deleting the membership and its household role',
      async ({ remover, target }) => {
        const owner = await actors.user();
        const admin = await actors.user();
        const departing = await actors.user();

        const fixture = await actors.householdWithMembers({
          owner,
          name: 'Roster about to shrink',
          members: [
            { actor: admin, role: SystemRole.HouseholdAdmin },
            { actor: departing, role: target },
          ],
        });
        const householdId = fixture.household.id;
        const removed = fixture.members[1].member;
        const before = await roster(householdId);

        const response = await removeMember(
          remover === SystemRole.HouseholdOwner ? owner : admin,
          householdId,
          removed.id,
        ).expect(200);

        const { member } = memberEnvelope(response, 'DELETE /api/households/:id/members/:memberId');
        expect({ id: member.id, userId: member.userId }).toEqual({ id: removed.id, userId: departing.user.id });

        await expectMembershipGone(removed.id);
        await expect(roster(householdId)).resolves.toEqual(before.filter((row) => row.id !== removed.id));
      },
    );

    it.each([
      { role: SystemRole.HouseholdMember, label: ROLE_LABEL[SystemRole.HouseholdMember] },
      { role: SystemRole.HouseholdGuest, label: ROLE_LABEL[SystemRole.HouseholdGuest] },
    ])('refuses a $label who tries to remove anyone, with 403', async ({ role }) => {
      const owner = await actors.user();
      const remover = await actors.user();
      const target = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'Nobody removed',
        members: [
          { actor: remover, role },
          { actor: target, role: SystemRole.HouseholdMember },
        ],
      });
      const before = await roster(fixture.household.id);

      const response = await removeMember(remover, fixture.household.id, fixture.members[1].member.id).expect(403);

      // Neither household role holds `manage` on memberships, so the route
      // guard is what refuses them.
      expect(messageOf(response)).toBe(REFUSED_BY_GUARD);
      await expect(roster(fixture.household.id)).resolves.toEqual(before);
    });

    it('refuses, with 403, a user holding only the base role', async () => {
      // Refused at the route guard: nothing they hold grants `manage` on a
      // membership anywhere.
      const owner = await actors.user();
      const member = await actors.user();
      const outsider = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });
      const before = await roster(fixture.household.id);

      const response = await removeMember(outsider, fixture.household.id, fixture.members[0].member.id).expect(403);

      expect(messageOf(response)).toBe(REFUSED_BY_GUARD);
      await expect(roster(fixture.household.id)).resolves.toEqual(before);
    });

    it('refuses, with 403, the household owner of a different household', async () => {
      // Owning a household of their own, this outsider holds `manage` on
      // memberships and passes the route guard. What refuses them is the
      // service: the membership exists, but not where their grant reaches.
      // Without this case the suite never reaches that check, and the message
      // is what shows it did: the route guard's refusal reads differently.
      const owner = await actors.user();
      const member = await actors.user();
      const outsider = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });
      await actors.householdWithMembers({ owner: outsider, name: 'Somewhere else' });
      const before = await roster(fixture.household.id);

      const response = await removeMember(outsider, fixture.household.id, fixture.members[0].member.id).expect(403);

      expect(messageOf(response)).toBe(REFUSED_BY_SERVICE);
      await expect(roster(fixture.household.id)).resolves.toEqual(before);
    });

    it('answers 404 for a household that does not exist', async () => {
      const owner = await actors.user();
      const member = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });
      const before = await roster(fixture.household.id);
      const missingHouseholdId = randomUUID();

      const response = await removeMember(owner, missingHouseholdId, fixture.members[0].member.id).expect(404);

      // The household's 404, not the membership's: a membership that cannot be
      // found answers 404 too, and only the message tells the two apart.
      expect(messageOf(response)).toBe(`Household with ID ${missingHouseholdId} not found`);
      await expect(roster(fixture.household.id)).resolves.toEqual(before);
    });

    it("answers 404 for another household's membership sent through the caller's own household", async () => {
      // The caller may remove members of their own household, and the id names
      // a real membership. Only the pairing is wrong, and the route must not
      // reach across it.
      const owner = await actors.user();
      const otherOwner = await actors.user();
      const otherMember = await actors.user();

      const own = await actors.householdWithMembers({ owner, name: 'Own household' });
      const other = await actors.householdWithMembers({
        owner: otherOwner,
        name: 'Other household',
        members: [{ actor: otherMember, role: SystemRole.HouseholdMember }],
      });
      const before = await roster(other.household.id);

      await removeMember(owner, own.household.id, other.members[0].member.id).expect(404);

      await expect(roster(other.household.id)).resolves.toEqual(before);
    });

    it("deletes the removed member's excluded games and leaves another member's", async () => {
      // No route writes these rows yet (#367), so they are arranged directly.
      // The foreign key is RESTRICT, so a route that skipped them would fail
      // with a 500 rather than leave rows behind.
      const owner = await actors.user();
      const departing = await actors.user();
      const staying = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'Excluded games on both sides',
        members: [
          { actor: departing, role: SystemRole.HouseholdMember },
          { actor: staying, role: SystemRole.HouseholdMember },
        ],
      });
      const [departingMembership, stayingMembership] = fixture.members.map((entry) => entry.member);

      // Each member holds back one of their own games, which is what an
      // excluded game is.
      await db.client.excludedGame.createMany({
        data: [
          {
            householdMemberId: departingMembership.id,
            gameCollectionId: await arrangeCollectionEntry(db.client, departing.user.id, Visibility.Household),
          },
          {
            householdMemberId: stayingMembership.id,
            gameCollectionId: await arrangeCollectionEntry(db.client, staying.user.id, Visibility.Household),
          },
        ],
      });

      await removeMember(owner, fixture.household.id, departingMembership.id).expect(200);

      await expect(
        db.client.excludedGame.count({ where: { householdMemberId: departingMembership.id } }),
      ).resolves.toBe(0);
      await expect(db.client.excludedGame.count({ where: { householdMemberId: stayingMembership.id } })).resolves.toBe(
        1,
      );
    });
  });

  describe('leaving a household', () => {
    it.each(HOUSEHOLD_ROLE_NAMES.map((role) => ({ role, label: ROLE_LABEL[role] })))(
      'lets a $label leave, deleting the membership and its household role',
      async ({ role }) => {
        // The household owner case needs a second owner, and only the fixture can
        // make one: no route does (#158 made ownership transfer the only way
        // ownership changes hands).
        const owner = await actors.user();
        const leaver = await actors.user();

        const fixture = await actors.householdWithMembers({
          owner,
          name: 'About to be left',
          members: [{ actor: leaver, role }],
        });
        const left = fixture.members[0].member;

        const response = await leave(leaver, fixture.household.id).expect(200);

        const { member } = memberEnvelope(response, 'DELETE /api/households/:id/members/me');
        expect({ id: member.id, userId: member.userId }).toEqual({ id: left.id, userId: leaver.user.id });

        await expectMembershipGone(left.id);
        await expect(db.client.householdMember.count({ where: { id: fixture.owner.member.id } })).resolves.toBe(1);
      },
    );

    it("resolves …/members/me to a household admin's own membership, though their grants reach every one", async () => {
      // `manage` covers `delete`, so a household admin's grants match every
      // membership in the household; `me` must still mean their own. The
      // message is the leave route's. A request that reached the remove route
      // instead would look for a membership with the id `me` and answer 404.
      //
      // This catches a missing `userId` pin only when the query would have
      // picked another membership first, which depends on random ids. The staff
      // case in `permissions/staff-grant-seeds.spec.ts` catches it every time,
      // because staff hold no membership the query could pick by luck.
      const owner = await actors.user();
      const admin = await actors.user();
      const bystander = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'An admin on the way out',
        members: [
          { actor: admin, role: SystemRole.HouseholdAdmin },
          { actor: bystander, role: SystemRole.HouseholdMember },
        ],
      });
      const adminMembership = fixture.members[0].member;
      const before = await roster(fixture.household.id);

      const response = await leave(admin, fixture.household.id).expect(200);

      const { message, member } = memberEnvelope(response, 'DELETE /api/households/:id/members/me');
      expect(message).toMatch(/you have left the household/i);
      expect({ id: member.id, userId: member.userId }).toEqual({ id: adminMembership.id, userId: admin.user.id });

      await expect(roster(fixture.household.id)).resolves.toEqual(
        before.filter((row) => row.id !== adminMembership.id),
      );
    });

    it('stops answering a member who has just left, on the household they could read before', async () => {
      // The leave route's own eviction, read through `GET /households/:id`.
      // The list read would not show it: the list filters on live memberships,
      // so it drops the household whether or not the cached permissions went.
      const owner = await actors.user();
      const member = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'Read, then left',
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });

      await readHousehold(member, fixture.household.id).expect(200);

      await leave(member, fixture.household.id).expect(200);

      // 403, not 404: the household still exists, and this caller may no longer
      // see it.
      await readHousehold(member, fixture.household.id).expect(403);
    });
  });

  describe('the last owner', () => {
    it('cannot leave, and keeps their membership', async () => {
      const owner = await actors.user();
      const member = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'One owner',
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });
      const before = await roster(fixture.household.id);

      expectLastOwnerRefusal(await leave(owner, fixture.household.id), fixture.household.id);

      await expect(roster(fixture.household.id)).resolves.toEqual(before);
    });

    it('cannot be removed by a household admin, and keeps their membership', async () => {
      const owner = await actors.user();
      const admin = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'One owner, one admin',
        members: [{ actor: admin, role: SystemRole.HouseholdAdmin }],
      });
      const before = await roster(fixture.household.id);

      expectLastOwnerRefusal(
        await removeMember(admin, fixture.household.id, fixture.owner.member.id),
        fixture.household.id,
      );

      await expect(roster(fixture.household.id)).resolves.toEqual(before);
    });

    it('can leave once they have transferred ownership', async () => {
      const owner = await actors.user();
      const heir = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'Handed over, then left',
        members: [{ actor: heir, role: SystemRole.HouseholdMember }],
      });
      const heirMembership = fixture.members[0].member;

      await transferOwnership(owner, fixture.household.id, heirMembership.id).expect(200);

      await leave(owner, fixture.household.id).expect(200);

      await expectMembershipGone(fixture.owner.member.id);
      await expect(roster(fixture.household.id)).resolves.toEqual([
        { id: heirMembership.id, userId: heir.user.id, role: { role: { name: SystemRole.HouseholdOwner } } },
      ]);
    });
  });
});
