import { SystemRole, Visibility } from '@bge/database';
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
 * every member was shown up to five of every other member's entries, Private
 * ones included. It now reads through the `GameCollection` ceiling: a viewer
 * sees an entry in the sample only if they could read that entry by id.
 *
 * Two controls. The member's own view of the same household samples their
 * Private entry too, so its absence from another member's view comes from the
 * ceiling and not from the sample missing it. And the other member reads the
 * two entries by id with the answers the sample gives: the shared one 200, the
 * Private one 404.
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

  it("shows a member another member's Household-visible entry, and not their Private one", async () => {
    // Actors first, then the roster and rows, before anyone's first
    // authenticated request (#256 ordering rule).
    const owner = await actors.user();
    const viewer = await actors.user();
    const member = await actors.user();

    const { household } = await createHouseholdWithMembers(db.client, {
      owner,
      members: [
        { actor: viewer, role: SystemRole.HouseholdMember },
        { actor: member, role: SystemRole.HouseholdMember },
      ],
    });
    const privateEntry = await arrangeCollectionEntry(db.client, member.user.id, Visibility.Private);
    const sharedEntry = await arrangeCollectionEntry(db.client, member.user.id, Visibility.Household);

    // The control: the member's own view samples both, so the Private entry
    // is one the sample does reach.
    const ownView = memberGameSampleIds(
      await readHousehold(member, household.id).expect(200),
      'GET /api/households/:id as the member',
      member.user.id,
    );
    expect([...ownView].sort()).toEqual([privateEntry, sharedEntry].sort());

    const viewersView = memberGameSampleIds(
      await readHousehold(viewer, household.id).expect(200),
      'GET /api/households/:id as another member',
      member.user.id,
    );
    expect(viewersView).toEqual([sharedEntry]);

    // The by-id reads agree with the sample.
    await readEntry(viewer, sharedEntry).expect(200);
    await readEntry(viewer, privateEntry).expect(404);
  });
});
