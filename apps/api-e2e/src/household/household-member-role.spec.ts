import { SystemRole } from '@bge/database';
import { createActors, type Actors, type HouseholdRoleName, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createMemberClient, membersPath } from './household-request';

/**
 * Changing a member's household role, over HTTP (#760).
 *
 * `PATCH …/members/:memberId/role` is the only path that moves an existing
 * member between the household admin, member and guest roles (#169; the
 * household README lists every path). What a household admin may do on it is
 * driven in `household-admin-role.spec.ts` (#168); staff changing a foreign
 * member's role in `permissions/staff-grant-seeds.spec.ts`; races and deleted
 * households in `member-ownership-races.spec.ts`, `household-lifecycle.spec.ts`
 * and `role-transition-tombstone.spec.ts`. This suite adds the refusals and the
 * new role taking effect, up and down, which a unit spec with a mocked
 * database can only assert as calls.
 *
 * Each refusal is told apart by its message, since four of them answer 400
 * and two answer 403, and is checked against the database so a refusal that
 * wrote anyway fails. Every household is arranged before any of its actors
 * sends a request, as the API caches each user's permissions on first use
 * (#272); every role change after that goes through the route, which evicts.
 */
describe('changing a household role (#760)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const { changeRole, removeMember } = createMemberClient(baseUrl);

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const SELF_REFUSAL = 'You cannot change your own household role';
  const OWNER_REFUSAL = "A household owner's role cannot be changed here — use the transfer-ownership flow";
  /** The route guard's refusal, for an actor holding no `manage` on memberships at all. */
  const REFUSED_BY_GUARD = 'You do not have permission to perform this action.';

  const messageOf = (response: { body: unknown }): unknown => (response.body as { message?: unknown } | null)?.message;

  const roleOf = async (memberId: string) =>
    (
      await db.client.householdRole.findUniqueOrThrow({
        where: { householdMemberId: memberId },
        select: { role: { select: { name: true } } },
      })
    ).role.name;

  const readRoster = (actor: SessionActor, householdId: string) =>
    request(baseUrl).get(membersPath(householdId)).set(actor.headers);

  /**
   * A household owner, a household admin, and one more member for each role
   * in `others`, in that order.
   */
  const household = async (...others: HouseholdRoleName[]) => {
    const [owner, admin, ...rest] = await Promise.all([
      actors.user(),
      actors.user(),
      ...others.map(() => actors.user()),
    ]);
    const fixture = await actors.householdWithMembers({
      owner,
      name: 'Roles about to change',
      members: [
        { actor: admin, role: SystemRole.HouseholdAdmin },
        ...others.map((role, index) => ({ actor: rest[index], role })),
      ],
    });
    const [adminMembership, ...otherMemberships] = fixture.members.map((entry) => entry.member);

    return {
      householdId: fixture.household.id,
      owner,
      ownerMemberId: fixture.owner.member.id,
      admin,
      adminMemberId: adminMembership.id,
      others: otherMemberships.map((member, index) => ({ actor: rest[index], memberId: member.id })),
    };
  };

  describe('refusals', () => {
    it('refuses a household owner their own role, with 400, and leaves them household owner', async () => {
      // An owner's own row is inside their manage, so the scoped read finds it
      // and the check after it refuses.
      const { householdId, owner, ownerMemberId } = await household();

      const response = await changeRole(owner, householdId, ownerMemberId, SystemRole.HouseholdMember).expect(400);

      expect(messageOf(response)).toBe(SELF_REFUSAL);
      await expect(roleOf(ownerMemberId)).resolves.toBe(SystemRole.HouseholdOwner);
    });

    it('refuses a household admin their own role, with 400 rather than 403, and leaves them household admin', async () => {
      // A household admin's own row is outside their manage (#168), so the
      // scoped read misses it. The service asks why before answering, and says
      // so, rather than a 403 that reads as a missing permission.
      const { householdId, admin, adminMemberId } = await household();

      const response = await changeRole(admin, householdId, adminMemberId, SystemRole.HouseholdMember).expect(400);

      expect(messageOf(response)).toBe(SELF_REFUSAL);
      await expect(roleOf(adminMemberId)).resolves.toBe(SystemRole.HouseholdAdmin);
    });

    it("refuses staff a household owner's role, with 400, and leaves them household owner", async () => {
      // Every owner change goes through transfer ownership (#158). Only staff
      // reach this check, since `manage:household_member:administer` carries
      // no condition and their scoped read finds the household owner. A
      // household owner asking about themselves is refused as a self change
      // first, and a household admin's manage stops at the member and guest
      // roles (#168).
      const [{ householdId, ownerMemberId }, staff] = await Promise.all([household(), actors.admin()]);

      const response = await changeRole(staff, householdId, ownerMemberId, SystemRole.HouseholdMember).expect(400);

      expect(messageOf(response)).toBe(OWNER_REFUSAL);
      await expect(roleOf(ownerMemberId)).resolves.toBe(SystemRole.HouseholdOwner);
    });

    it('refuses the household owner role in the body, with 400 from validation, and leaves the role as it was', async () => {
      const { householdId, owner, others } = await household(SystemRole.HouseholdMember);
      const [member] = others;

      const response = await changeRole(owner, householdId, member.memberId, SystemRole.HouseholdOwner).expect(400);

      expect(messageOf(response)).toEqual([expect.stringMatching(/^role must be one of the following values/)]);
      await expect(roleOf(member.memberId)).resolves.toBe(SystemRole.HouseholdMember);
    });

    it.each([
      { role: SystemRole.HouseholdMember, label: 'someone with the member role' },
      { role: SystemRole.HouseholdGuest, label: 'a household guest' },
    ])('refuses $label any role change, with 403 from the route guard', async ({ role }) => {
      const { householdId, others } = await household(role, SystemRole.HouseholdGuest);
      const [changer, target] = others;

      const response = await changeRole(changer.actor, householdId, target.memberId, SystemRole.HouseholdMember).expect(
        403,
      );

      // Neither household role holds `manage` on memberships.
      expect(messageOf(response)).toBe(REFUSED_BY_GUARD);
      await expect(roleOf(target.memberId)).resolves.toBe(SystemRole.HouseholdGuest);
    });
  });

  describe('taking effect', () => {
    it('answers someone promoted to household admin by that role on their first request after the change', async () => {
      // Their first request caches the member role's permissions, which hold
      // no `manage` on memberships. The route evicts them after the change
      // commits, so the next request builds them again from the household
      // admin role, and removing a household guest goes through. Kept
      // permissions would be refused by the route guard, so the status alone
      // shows the eviction happened.
      const { householdId, owner, others } = await household(SystemRole.HouseholdMember, SystemRole.HouseholdGuest);
      const [promoted, guest] = others;

      await readRoster(promoted.actor, householdId).expect(200);

      await changeRole(owner, householdId, promoted.memberId, SystemRole.HouseholdAdmin).expect(200);
      await expect(roleOf(promoted.memberId)).resolves.toBe(SystemRole.HouseholdAdmin);

      await removeMember(promoted.actor, householdId, guest.memberId).expect(200);

      await expect(db.client.householdMember.count({ where: { id: guest.memberId } })).resolves.toBe(0);
    });

    it('answers a household admin by the member role on their first request after the change', async () => {
      // The household admin's first request caches their permissions. The
      // route evicts them after the change commits, so the next request builds
      // them again from the member role, which holds no `manage` on
      // memberships: the route guard refuses a removal they could have made a
      // moment before. Kept permissions pass the guard and are refused by the
      // service instead, which reads the roster afresh: still a 403, so here
      // only the message shows the eviction happened.
      const { householdId, owner, admin, adminMemberId, others } = await household(SystemRole.HouseholdGuest);
      const [guest] = others;

      await readRoster(admin, householdId).expect(200);

      await changeRole(owner, householdId, adminMemberId, SystemRole.HouseholdMember).expect(200);
      await expect(roleOf(adminMemberId)).resolves.toBe(SystemRole.HouseholdMember);

      const response = await removeMember(admin, householdId, guest.memberId).expect(403);

      expect(messageOf(response)).toBe(REFUSED_BY_GUARD);
      await expect(db.client.householdMember.count({ where: { id: guest.memberId } })).resolves.toBe(1);
    });
  });
});
