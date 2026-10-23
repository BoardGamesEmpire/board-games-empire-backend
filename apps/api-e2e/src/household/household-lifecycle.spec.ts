import { InviteStatus, Reach, SystemRole } from '@bge/database';
import { arrangeInvite, befriend, createActors, type Actors, type SessionActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { createMemberClient, membersPath } from './household-request';
import { createEnvelope, listEnvelope, readEnvelope } from './household-wire';

/**
 * The schema-level half of #257: soft-delete semantics, invite revocation, and
 * language-tag resolution. Everything here is asserted as PERSISTED STATE or as
 * what a subsequent request can see — never as an emitter call, which is all a
 * mocked `DatabaseService` can observe and is the specific gap this suite exists
 * to close.
 */
describe('household lifecycle', () => {
  const baseUrl = requireBaseUrl(process.env);
  const HOUSEHOLDS_PATH = '/api/households';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const listHouseholds = (actor: SessionActor) => request(baseUrl).get(HOUSEHOLDS_PATH).set(actor.headers);

  const readHousehold = (actor: SessionActor, id: string) =>
    request(baseUrl).get(`${HOUSEHOLDS_PATH}/${id}`).set(actor.headers);

  const { removeMember, leave, transferOwnership, changeRole } = createMemberClient(baseUrl);

  /** An address no account has, so an invite to it reaches nobody the suite signs in as. */
  const unknownAddress = () => `invitee-${randomUUID()}@e2e.invalid`;

  describe('creating a household', () => {
    it('persists the creator as its HouseholdOwner and returns the row', async () => {
      const actor = await actors.user();

      const created = createEnvelope(
        await request(baseUrl)
          .post(HOUSEHOLDS_PATH)
          .set(actor.headers)
          .send({ name: 'Founded household', description: 'a description' })
          .expect(201),
        'POST /api/households',
      );

      expect(created.household.createdById).toBe(actor.user.id);
      expect(created.household.deletedAt).toBeNull();
      // The schema default, not something the payload supplied.
      expect(created.household.reach).toBe(Reach.Private);

      const members = await db.client.householdMember.findMany({
        where: { householdId: created.household.id },
        select: { userId: true, role: { select: { role: { select: { name: true } } } } },
      });

      expect(members).toHaveLength(1);
      expect(members[0].userId).toBe(actor.user.id);
      expect(members[0].role?.role.name).toBe(SystemRole.HouseholdOwner);
    });

    it('projects the member roster and language tag on the detail route', async () => {
      const owner = await actors.user();
      const member = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'Rostered household',
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });

      const detail = readEnvelope(
        await readHousehold(owner, fixture.household.id).expect(200),
        'GET /api/households/:id',
      );

      const roles = detail.household.members.map((entry) => entry.role?.role.name).sort();
      expect(roles).toEqual([SystemRole.HouseholdMember, SystemRole.HouseholdOwner].sort());
      // Arranged without a language, so the embed resolves to null rather than
      // being absent — the difference matters to a client that destructures it.
      expect(detail.household.languageTag).toBeNull();
    });

    /**
     * #665. The detail reaches every reader of the household, a member's
     * friends included, and only the household's owners and admins, and staff,
     * read its invites. With an invite pending, no reader's detail carries one,
     * the owner's included: they list them at
     * `GET /households/:householdId/invites`.
     *
     * `readEnvelope` refuses an `invites` key too, so every detail read in the
     * suite checks it; this one names the readers it was about. The members
     * array is asserted first, so a body that never carried the household
     * cannot pass the absence.
     */
    it("embeds none of the household's invites, for any reader", async () => {
      const [owner, member, guest, friend] = await Promise.all([
        actors.user(),
        actors.user(),
        actors.user(),
        actors.user(),
      ]);
      const fixture = await actors.householdWithMembers({
        owner,
        name: 'Household with a pending invite',
        members: [
          { actor: member, role: SystemRole.HouseholdMember },
          { actor: guest, role: SystemRole.HouseholdGuest },
        ],
      });
      await db.client.household.update({ where: { id: fixture.household.id }, data: { reach: Reach.Friends } });
      await befriend(db.client, friend, member);

      await arrangeInvite(db.client, {
        inviter: owner,
        householdId: fixture.household.id,
        status: InviteStatus.Pending,
        inviteeEmail: unknownAddress(),
      });

      const responses = await Promise.all(
        [owner, member, guest, friend].map((reader) => readHousehold(reader, fixture.household.id).expect(200)),
      );

      for (const response of responses) {
        expect(response.body.household.members).toHaveLength(3);
        expect(response.body.household).not.toHaveProperty('invites');
      }
    });
  });

  describe('language tag resolution', () => {
    it('connects a seeded BCP 47 tag', async () => {
      const actor = await actors.user();

      const created = createEnvelope(
        await request(baseUrl)
          .post(HOUSEHOLDS_PATH)
          .set(actor.headers)
          .send({ name: 'Brazilian household', language: 'pt-BR' })
          .expect(201),
        'POST /api/households',
      );

      const detail = readEnvelope(
        await readHousehold(actor, created.household.id).expect(200),
        'GET /api/households/:id',
      );
      expect(detail.household.languageTag?.tag).toBe('pt-BR');
    });

    it('canonicalizes case before resolving, so a mangled tag reaches the same row', async () => {
      // `canonicalizeTag` runs `Intl.getCanonicalLocales`, so 'PT-br' becomes
      // 'pt-BR'. Asserted end-to-end because the seeded rows store the canonical
      // spelling: without the canonicalization pass this is a 400, and a client
      // sending a lower-cased region subtag is not doing anything wrong.
      const actor = await actors.user();

      const created = createEnvelope(
        await request(baseUrl)
          .post(HOUSEHOLDS_PATH)
          .set(actor.headers)
          .send({ name: 'Mangled tag', language: 'PT-br' })
          .expect(201),
        'POST /api/households',
      );

      const languageTag = await db.client.languageTag.findUniqueOrThrow({ where: { tag: 'pt-BR' } });
      expect(created.household.languageTagId).toBe(languageTag.id);
    });

    it('rejects a syntactically valid tag that is outside the seeded vocabulary', async () => {
      // 'fr' is seeded; 'fr-CA' is not. The distinction is the point — the tag
      // parses, canonicalizes, and still has no row, which is the branch a
      // fixture-backed test would miss by seeding whatever it asked for.
      const actor = await actors.user();

      await request(baseUrl)
        .post(HOUSEHOLDS_PATH)
        .set(actor.headers)
        .send({ name: 'Unsupported tag', language: 'fr-CA' })
        .expect(400);

      await expect(db.client.household.count({ where: { createdById: actor.user.id } })).resolves.toBe(0);
    });

    it('rejects a tag that is not a language tag at all', async () => {
      const actor = await actors.user();

      await request(baseUrl)
        .post(HOUSEHOLDS_PATH)
        .set(actor.headers)
        .send({ name: 'Nonsense tag', language: 'not a tag' })
        .expect(400);
    });
  });

  describe('soft deleting a household', () => {
    it('stamps deletedAt, hides it from both read routes, and keeps the member rows', async () => {
      const owner = await actors.user();
      const member = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'Doomed household',
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });

      const deleted = createEnvelope(
        await request(baseUrl).delete(`${HOUSEHOLDS_PATH}/${fixture.household.id}`).set(owner.headers).expect(200),
        'DELETE /api/households/:id',
      );
      expect(deleted.household.deletedAt).not.toBeNull();

      const persisted = await db.client.household.findUniqueOrThrow({ where: { id: fixture.household.id } });
      expect(persisted.deletedAt).not.toBeNull();

      // Gone from both read routes — and 404, not 403 (#257). The
      // existence probe filters `deletedAt: null`, so a former member learns
      // "gone" rather than "forbidden"; telling them otherwise would leak that
      // the row survives.
      await readHousehold(owner, fixture.household.id).expect(404);
      await readHousehold(member, fixture.household.id).expect(404);
      expect(listEnvelope(await listHouseholds(owner).expect(200), 'GET /api/households').households).toEqual([]);

      // A soft delete is reversible, so the roster is deliberately retained.
      await expect(db.client.householdMember.count({ where: { householdId: fixture.household.id } })).resolves.toBe(2);
    });

    it('revokes outstanding invites, both pending and awaiting approval', async () => {
      // The service revokes `{ in: [Pending, AwaitingApproval] }`. Covering only
      // Pending — as this issue originally specified — would leave half the
      // transition unverified, and AwaitingApproval is the half where a stale
      // token surviving would be least visible.
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner, name: 'Household with invites' });

      const pending = await arrangeInvite(db.client, {
        inviter: owner,
        householdId: fixture.household.id,
        status: InviteStatus.Pending,
        inviteeEmail: unknownAddress(),
      });
      const awaiting = await arrangeInvite(db.client, {
        inviter: owner,
        householdId: fixture.household.id,
        status: InviteStatus.AwaitingApproval,
        inviteeEmail: unknownAddress(),
      });
      const declined = await arrangeInvite(db.client, {
        inviter: owner,
        householdId: fixture.household.id,
        status: InviteStatus.Declined,
        inviteeEmail: unknownAddress(),
      });

      await request(baseUrl).delete(`${HOUSEHOLDS_PATH}/${fixture.household.id}`).set(owner.headers).expect(200);

      const statusOf = async (id: string): Promise<InviteStatus> =>
        (await db.client.invite.findUniqueOrThrow({ where: { id }, select: { status: true } })).status;

      await expect(statusOf(pending.id)).resolves.toBe(InviteStatus.Revoked);
      await expect(statusOf(awaiting.id)).resolves.toBe(InviteStatus.Revoked);
      // A settled invite is not resurrected into Revoked — the update is
      // scoped, not a blanket rewrite of the household's invite history.
      await expect(statusOf(declined.id)).resolves.toBe(InviteStatus.Declined);
    });

    it('leaves invites to other households alone', async () => {
      // `updateMany` is filtered on `householdId`; an unscoped version would
      // pass every assertion above while revoking the entire table.
      const owner = await actors.user();
      const doomed = await actors.householdWithMembers({ owner, name: 'Doomed' });
      const survivor = await actors.householdWithMembers({ owner, name: 'Survivor' });

      const bystander = await arrangeInvite(db.client, {
        inviter: owner,
        householdId: survivor.household.id,
        status: InviteStatus.Pending,
        inviteeEmail: unknownAddress(),
      });

      await request(baseUrl).delete(`${HOUSEHOLDS_PATH}/${doomed.household.id}`).set(owner.headers).expect(200);

      const invite = await db.client.invite.findUniqueOrThrow({
        where: { id: bystander.id },
        select: { status: true },
      });
      expect(invite.status).toBe(InviteStatus.Pending);
    });

    it('answers 404 for a mutation on a tombstone when the actor holds no other household role (#299)', async () => {
      // This was 403. The soft delete revokes the owner's household-scoped
      // grants as a side effect: `loadUserGraph` selects memberships `where
      // household.deletedAt is null`, and the delete evicts the graph, so the
      // rebuild carries no HouseholdOwner permission at all. With no
      // `update`/`delete` rule on Household anywhere in their abilities,
      // `PoliciesGuard` denied before `assertHouseholdExists` could report the
      // row as gone.
      //
      // 404 won because the 403 depended on unrelated state (the case below is
      // the other half of that), and it told an ex-owner "forbidden" about a
      // household that is gone. The liveness guard now answers before any
      // policy runs.
      const owner = await actors.user();
      const fixture = await actors.householdWithMembers({ owner, name: 'Deleted twice?' });

      await request(baseUrl).delete(`${HOUSEHOLDS_PATH}/${fixture.household.id}`).set(owner.headers).expect(200);

      await request(baseUrl).delete(`${HOUSEHOLDS_PATH}/${fixture.household.id}`).set(owner.headers).expect(404);
      await request(baseUrl)
        .patch(`${HOUSEHOLDS_PATH}/${fixture.household.id}`)
        .set(owner.headers)
        .send({ name: 'Renaming a tombstone' })
        .expect(404);
    });

    it('answers the same 404 for that tombstone when the actor still owns another household', async () => {
      // Same request, same tombstone, and now the same status (#299). Owning a
      // SECOND, live household keeps Household `update`/`delete` rules in the
      // graph, so the type-level guard would pass on the rules' existence and
      // the service's probe would 404; before the liveness guard that was the
      // only path to 404, and the case above got 403 instead.
      //
      // Kept as a pair with the case above because the difference between them
      // is invisible to any test that owns exactly one household.
      const owner = await actors.user();
      const doomed = await actors.householdWithMembers({ owner, name: 'Doomed' });
      const survivor = await actors.householdWithMembers({ owner, name: 'Survivor' });

      await request(baseUrl).delete(`${HOUSEHOLDS_PATH}/${doomed.household.id}`).set(owner.headers).expect(200);

      await request(baseUrl)
        .patch(`${HOUSEHOLDS_PATH}/${doomed.household.id}`)
        .set(owner.headers)
        .send({ name: 'Renaming a tombstone' })
        .expect(404);
      await request(baseUrl).delete(`${HOUSEHOLDS_PATH}/${doomed.household.id}`).set(owner.headers).expect(404);

      // The surviving household is untouched and still mutable.
      await request(baseUrl)
        .patch(`${HOUSEHOLDS_PATH}/${survivor.household.id}`)
        .set(owner.headers)
        .send({ name: 'Still mine' })
        .expect(200);
    });

    it('answers 404 on every member route of a tombstone, and leaves the roster as it was (#299)', async () => {
      // The member write routes had the same split: their policies are on
      // `manage`/`delete` HouseholdMember and `update` HouseholdRole, which an
      // actor whose only household was deleted no longer holds. The roster is
      // frozen while the household is deleted (#386), so every one of these is
      // a refusal, and the counts below show none of them got through.
      const owner = await actors.user();
      const member = await actors.user();

      const fixture = await actors.householdWithMembers({
        owner,
        name: 'Roster of a tombstone',
        members: [{ actor: member, role: SystemRole.HouseholdMember }],
      });

      const householdId = fixture.household.id;
      const memberId = fixture.members[0].member.id;
      const rosterPath = membersPath(householdId);

      await request(baseUrl).delete(`${HOUSEHOLDS_PATH}/${householdId}`).set(owner.headers).expect(200);

      await request(baseUrl).get(rosterPath).set(owner.headers).expect(404);
      await request(baseUrl).get(`${rosterPath}/${memberId}`).set(owner.headers).expect(404);
      await changeRole(owner, householdId, memberId, SystemRole.HouseholdAdmin).expect(404);
      await transferOwnership(owner, householdId, memberId).expect(404);
      await removeMember(owner, householdId, memberId).expect(404);
      await leave(member, householdId).expect(404);

      const roster = await db.client.householdMember.findMany({
        where: { householdId },
        select: { userId: true, role: { select: { role: { select: { name: true } } } } },
      });

      expect(roster).toHaveLength(2);
      expect(roster).toEqual(
        expect.arrayContaining([
          { userId: owner.user.id, role: { role: { name: SystemRole.HouseholdOwner } } },
          { userId: member.user.id, role: { role: { name: SystemRole.HouseholdMember } } },
        ]),
      );
    });
  });
});
