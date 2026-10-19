import { Reach, SystemRole } from '@bge/database';
import { createActors, createHouseholdWithMembers, type Actors, type SessionActor } from '@bge/testing-e2e';
import request from 'supertest';
import { arrangeCollectionEntry } from '../game-collection/game-collection-fixtures';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { memberGameSampleIds } from './household-wire';

/**
 * The game sample `GET /api/households/:id` embeds for each member (#514).
 *
 * The sample was raw SQL that filtered only the owner and the tombstone, so
 * it ignored what a member had held back from the household. It now reads
 * through the `GameCollection` ceiling: a viewer sees an entry in the sample
 * only if they could read that entry by id, and each test reads the entries by
 * id too, with the answers the sample gives.
 *
 * A household sees a member's entries through collection sharing, whatever
 * their reach (#495): the reach says who beyond the member's households sees
 * an entry. So a Private entry is in the game pool, an excluded one is not,
 * and with sharing off only what the reach admits on its own is left. A
 * deleted household shares nothing, though its member rows outlive it.
 */
describe('household member game sample', () => {
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

  const readHousehold = (actor: SessionActor, id: string) =>
    request(baseUrl).get(`/api/households/${id}`).set(actor.headers);

  const readEntry = (actor: SessionActor, id: string) =>
    request(baseUrl).get(`/api/game-collections/${id}`).set(actor.headers);

  /**
   * An owner, a viewer and the member whose games are sampled, in one
   * household. Actors first, then the roster and rows, before anyone's first
   * authenticated request (#256 ordering rule).
   */
  const arrangeHousehold = async () => {
    const owner = await actors.user();
    const viewer = await actors.user();
    const member = await actors.user();

    const { household, members } = await createHouseholdWithMembers(db.client, {
      owner,
      members: [
        { actor: viewer, role: SystemRole.HouseholdMember },
        { actor: member, role: SystemRole.HouseholdMember },
      ],
    });
    const membership = members.find((entry) => entry.member.userId === member.user.id)?.member;
    if (membership === undefined) {
      throw new Error('the fixture left the sampled member off the roster');
    }

    return { household, owner, viewer, member, membership };
  };

  const viewersSample = async (viewer: SessionActor, householdId: string, memberId: string) =>
    memberGameSampleIds(
      await readHousehold(viewer, householdId).expect(200),
      'GET /api/households/:id as another member',
      memberId,
    );

  it("shows a member another member's Private entry, and not one they excluded from the household", async () => {
    const { household, viewer, member, membership } = await arrangeHousehold();
    const privateEntry = await arrangeCollectionEntry(db.client, member.user.id, Reach.Private);
    const excludedEntry = await arrangeCollectionEntry(db.client, member.user.id, Reach.Private);
    await db.client.excludedGame.create({
      data: { householdMemberId: membership.id, gameCollectionId: excludedEntry },
    });

    expect(await viewersSample(viewer, household.id, member.user.id)).toEqual([privateEntry]);

    await readEntry(viewer, privateEntry).expect(200);
    await readEntry(viewer, excludedEntry).expect(404);
  });

  it('shows only what the reach admits once the member turns collection sharing off', async () => {
    const { household, viewer, member, membership } = await arrangeHousehold();
    const privateEntry = await arrangeCollectionEntry(db.client, member.user.id, Reach.Private);
    const publicEntry = await arrangeCollectionEntry(db.client, member.user.id, Reach.Public);
    await db.client.householdMember.update({ where: { id: membership.id }, data: { showAllGames: false } });

    // The Public entry is the control: the sample still reaches this member,
    // so the Private entry's absence is collection sharing's doing.
    expect(await viewersSample(viewer, household.id, member.user.id)).toEqual([publicEntry]);

    await readEntry(viewer, publicEntry).expect(200);
    await readEntry(viewer, privateEntry).expect(404);
  });

  it("stops showing a member another member's Private entry once the household is deleted", async () => {
    const { household, owner, viewer, member } = await arrangeHousehold();
    const privateEntry = await arrangeCollectionEntry(db.client, member.user.id, Reach.Private);

    // Read while the household is live, so the 404 after is the delete's doing.
    await readEntry(viewer, privateEntry).expect(200);

    await request(baseUrl).delete(`/api/households/${household.id}`).set(owner.headers).expect(200);

    await readEntry(viewer, privateEntry).expect(404);
  });
});
