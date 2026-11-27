import { GameCondition, GameMedium, GameRemovalReason, Reach, SystemRole } from '@bge/database';
import type { Actors, AuthenticatedActor, SessionActor } from '@bge/testing-e2e';
import { befriend, createActors, createHouseholdWithMembers } from '@bge/testing-e2e';
import request from 'supertest';
import { arrangePlatformGame } from '../list/list-fixtures';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import type { GameCollectionWire, PublicCopyWire } from './game-collection-wire';
import {
  copyEnvelope,
  listCollectionsEnvelope,
  listCopiesEnvelope,
  ownerRowCopies,
  publicRowCopies,
  readCollectionEnvelope,
} from './game-collection-wire';

/**
 * Who sees what of a copy on a collection row (#1231).
 *
 * What a copy cost, what it is worth, where and when it was acquired, and its
 * note are its owner's alone, whatever the entry's reach. Anyone who can read
 * the entry sees each owned copy's id, edition and condition. Rows for every
 * other reader select a public copy shape that has no private field, so these
 * tests read the keys each copy carries on the wire, not only their values.
 *
 * Each reader's grant to the entry is real (a friendship, a household, the
 * Public reach), and each test reads the entry first, so a reader refused the
 * entry can't pass for one shown no private field.
 */
describe('copy privacy on collection rows (#1231)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const COLLECTIONS_PATH = '/api/game-collections';

  /** The only keys a copy carries for a reader who isn't its owner (#1231). */
  const PUBLIC_COPY_KEYS = ['condition', 'id', 'release'];

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const readEntry = (caller: AuthenticatedActor, id: string) =>
    request(baseUrl).get(`${COLLECTIONS_PATH}/${id}`).set(caller.headers);

  const listUserCollection = (caller: AuthenticatedActor, userId: string) =>
    request(baseUrl).get(`/api/users/${userId}/game-collections`).set(caller.headers);

  /** The row for `entryId` on a page of rows, or a failure naming the page. */
  const rowOnPage = (collections: readonly GameCollectionWire[], entryId: string, description: string) => {
    const row = collections.find((listed) => listed.id === entryId);
    if (row === undefined) {
      throw new Error(`${description}: the page carried no row for entry ${entryId}`);
    }

    return row;
  };

  /** The entry's row as `reader` reads it by id. */
  const rowById = async (reader: AuthenticatedActor, entryId: string, who: string) => {
    const description = `GET ${COLLECTIONS_PATH}/:id as ${who}`;

    return {
      row: readCollectionEnvelope(await readEntry(reader, entryId).expect(200), description).collection,
      description,
    };
  };

  /** The entry's row on `ownerId`'s collection as `reader` lists it. */
  const rowListed = async (reader: AuthenticatedActor, ownerId: string, entryId: string, who: string) => {
    const description = `GET /api/users/:userId/game-collections as ${who}`;
    const page = listCollectionsEnvelope(await listUserCollection(reader, ownerId).expect(200), description);

    return { row: rowOnPage(page.collections, entryId, description), description };
  };

  /**
   * Each copy's keys, sorted, read from the row's raw `copies` as the wire
   * carried them, not from a parse: a private field can't hide behind a
   * passing value check, nor behind a schema that drops unknown keys.
   */
  const keysOf = (row: GameCollectionWire, description: string): string[][] => {
    const copies: unknown = (row as unknown as Record<string, unknown>)['copies'];
    if (!Array.isArray(copies)) {
      throw new Error(`${description}: collection row ${row.id} carried no 'copies' array`);
    }

    return copies.map((copy: unknown) => Object.keys(copy as Record<string, unknown>).sort());
  };

  /** Every private field a copy has, set by its owner (#1231). */
  const EVERY_PRIVATE_FIELD = {
    acquiredFrom: 'A friend moving abroad',
    acquiredOn: '2020-06',
    condition: GameCondition.LikeNew,
    currentValue: { amount: 6000, currency: 'EUR' },
    note: 'Sleeved, **one** card missing',
    pricePaid: { amount: 2500, currency: 'USD' },
  } as const;

  /**
   * An entry `owner` adds through the route with `reach`, holding one copy
   * whose every private field is set, of an edition of its platform game.
   */
  const addedEntry = async (owner: SessionActor, reach: Reach) => {
    const { platformGameId } = await arrangePlatformGame(db.client);
    const release = await db.client.gameRelease.create({
      data: { platformGameId, editionKey: 'e2e-deluxe', editionName: 'Deluxe', releaseYear: 2019 },
      select: { id: true },
    });
    const { collection } = readCollectionEnvelope(
      await request(baseUrl)
        .post(COLLECTIONS_PATH)
        .set(owner.headers)
        .send({
          platformGameId,
          medium: GameMedium.Physical,
          reach,
          copy: { ...EVERY_PRIVATE_FIELD, releaseId: release.id },
        })
        .expect(201),
      "POST /api/game-collections as the entry's owner",
    );

    return { entryId: collection.id, releaseId: release.id };
  };

  /** The one copy of the entry, as a reader who isn't its owner should see it. */
  const publicCopyOf = async (entryId: string, releaseId: string): Promise<PublicCopyWire> => {
    const { id } = await db.client.collectionCopy.findFirstOrThrow({ where: { entryId }, select: { id: true } });

    return {
      condition: GameCondition.LikeNew,
      id,
      release: { editionName: 'Deluxe', id: releaseId, releaseYear: 2019 },
    };
  };

  it("a friend reading another user's collection gets no private copy field", async () => {
    const owner = await actors.user();
    const friend = await actors.user();
    await befriend(db.client, owner, friend);
    const { entryId, releaseId } = await addedEntry(owner, Reach.Public);

    const { row, description } = await rowListed(friend, owner.user.id, entryId, 'a friend');
    const copies = publicRowCopies(row, description);

    expect(keysOf(row, description)).toEqual([PUBLIC_COPY_KEYS]);
    expect(copies).toEqual([await publicCopyOf(entryId, releaseId)]);
  });

  // The review's third focus: the by-id read is the one a single shared
  // include would have sent the owner's shape on (#1231).
  it('a friend reading by id gets no private copy field', async () => {
    const owner = await actors.user();
    const friend = await actors.user();
    await befriend(db.client, owner, friend);
    const { entryId, releaseId } = await addedEntry(owner, Reach.Public);

    const { row, description } = await rowById(friend, entryId, 'a friend');
    const copies = publicRowCopies(row, description);

    expect(keysOf(row, description)).toEqual([PUBLIC_COPY_KEYS]);
    expect(copies).toEqual([await publicCopyOf(entryId, releaseId)]);
  });

  // A household sees a member's entries whatever their reach (#495), so the
  // Private entry is read through the household alone, and the Public one
  // through either grant.
  it('a household member gets no private copy field', async () => {
    const owner = await actors.user();
    const member = await actors.user();
    await createHouseholdWithMembers(db.client, {
      owner,
      members: [{ actor: member, role: SystemRole.HouseholdMember }],
    });
    const publicEntry = await addedEntry(owner, Reach.Public);
    const privateEntry = await addedEntry(owner, Reach.Private);

    for (const { entryId, releaseId } of [publicEntry, privateEntry]) {
      const expected = [await publicCopyOf(entryId, releaseId)];

      for (const { row, description } of [
        await rowListed(member, owner.user.id, entryId, 'a household member'),
        await rowById(member, entryId, 'a household member'),
      ]) {
        const copies = publicRowCopies(row, description);

        expect(keysOf(row, description)).toEqual([PUBLIC_COPY_KEYS]);
        expect(copies).toEqual(expected);
      }
    }
  });

  // Staff read every entry, whatever its reach, and still never a copy's
  // private fields: the privacy policy says so (#1231). The entry is Private,
  // so the read comes from the staff grant alone.
  it('an Admin reading by id gets no private copy field (#1231)', async () => {
    const owner = await actors.user();
    const admin = await actors.admin();
    const { entryId, releaseId } = await addedEntry(owner, Reach.Private);

    const { row, description } = await rowById(admin, entryId, 'an Admin');
    const copies = publicRowCopies(row, description);

    expect(keysOf(row, description)).toEqual([PUBLIC_COPY_KEYS]);
    expect(copies).toEqual([await publicCopyOf(entryId, releaseId)]);
  });

  // Each copy write answers the copy in the entry owner's shape, so the writes are
  // the entry owner's alone, as the copy list is. The server's Owner holds every
  // permission, so the update conditions alone would let them write, and
  // read the answer (#1231).
  it("the server's Owner can't add, edit or remove another user's copies, and nothing changes (#1231)", async () => {
    const owner = await actors.user();
    const serverOwner = await actors.owner();
    const { entryId } = await addedEntry(owner, Reach.Private);
    const { id: copyId } = await db.client.collectionCopy.findFirstOrThrow({
      where: { entryId },
      select: { id: true },
    });
    const before = await db.client.gameCollection.findUniqueOrThrow({
      where: { id: entryId },
      select: { lastUpdated: true, deletedAt: true, copies: { orderBy: { id: 'asc' } } },
    });

    // The control: the server's Owner reads the entry, through their grant.
    await readEntry(serverOwner, entryId).expect(200);

    const copiesPath = `${COLLECTIONS_PATH}/${entryId}/copies`;
    // The edit names the copy's own condition, so it would change nothing
    // but answer the copy in full.
    const attempts = [
      () => request(baseUrl).post(copiesPath).set(serverOwner.headers).send({ condition: GameCondition.Good }),
      () =>
        request(baseUrl)
          .patch(`${copiesPath}/${copyId}`)
          .set(serverOwner.headers)
          .send({ condition: GameCondition.LikeNew }),
      () => request(baseUrl).delete(`${copiesPath}/${copyId}`).set(serverOwner.headers),
    ];
    for (const attempt of attempts) {
      const response = await attempt();

      expectErrorEnvelope(response, { status: 404, code: 'COLLECTION_ENTRY_NOT_FOUND' });
      expect(response.body).not.toHaveProperty('copy');
    }

    await expect(
      db.client.gameCollection.findUniqueOrThrow({
        where: { id: entryId },
        select: { lastUpdated: true, deletedAt: true, copies: { orderBy: { id: 'asc' } } },
      }),
    ).resolves.toEqual(before);
  });

  it('an anonymous reader of a Public entry gets no private copy field', async () => {
    const owner = await actors.user();
    const guest = await actors.anonymous();
    const { entryId, releaseId } = await addedEntry(owner, Reach.Public);
    const expected = [await publicCopyOf(entryId, releaseId)];

    for (const { row, description } of [
      await rowListed(guest, owner.user.id, entryId, 'an anonymous guest'),
      await rowById(guest, entryId, 'an anonymous guest'),
    ]) {
      const copies = publicRowCopies(row, description);

      expect(keysOf(row, description)).toEqual([PUBLIC_COPY_KEYS]);
      expect(copies).toEqual(expected);
    }
  });

  // A removed copy says what the owner sold or gave away, and a taken-back one
  // what never happened: both are the entry owner's alone (#1231).
  it('removed copies are never shown to other readers', async () => {
    const owner = await actors.user();
    const friend = await actors.user();
    await befriend(db.client, owner, friend);
    const { entryId, releaseId } = await addedEntry(owner, Reach.Public);
    const kept = await publicCopyOf(entryId, releaseId);

    const sold = copyEnvelope(
      await request(baseUrl)
        .post(`${COLLECTIONS_PATH}/${entryId}/copies`)
        .set(owner.headers)
        .send({ condition: GameCondition.Good })
        .expect(201),
      "POST /api/game-collections/:id/copies as the entry's owner",
    );
    await request(baseUrl)
      .delete(`${COLLECTIONS_PATH}/${entryId}/copies/${sold.id}`)
      .query({ reason: GameRemovalReason.Sold })
      .set(owner.headers)
      .expect(200);
    const takenBack = copyEnvelope(
      await request(baseUrl)
        .post(`${COLLECTIONS_PATH}/${entryId}/copies`)
        .set(owner.headers)
        .send({ condition: GameCondition.Poor })
        .expect(201),
      "POST /api/game-collections/:id/copies as the entry's owner",
    );
    await request(baseUrl)
      .post(`${COLLECTIONS_PATH}/${entryId}/copies/${takenBack.id}/retraction`)
      .set(owner.headers)
      .expect(200);

    for (const { row, description } of [
      await rowListed(friend, owner.user.id, entryId, 'a friend'),
      await rowById(friend, entryId, 'a friend'),
    ]) {
      expect(publicRowCopies(row, description)).toEqual([kept]);
      expect(row.quantity).toBe(1);
    }

    // The control: the removed and taken-back copies are there, and the
    // owner's copy list names all three.
    const ownersList = listCopiesEnvelope(
      await request(baseUrl).get(`${COLLECTIONS_PATH}/${entryId}/copies`).set(owner.headers).expect(200),
      "GET /api/game-collections/:id/copies as the entry's owner",
    );
    expect(ownersList.map(({ id }) => id).sort()).toEqual([kept.id, sold.id, takenBack.id].sort());
  });

  it("the owner's own rows carry every copy field", async () => {
    const owner = await actors.user();
    const { entryId, releaseId } = await addedEntry(owner, Reach.Public);
    const ownersCopy = {
      ...EVERY_PRIVATE_FIELD,
      createdAt: expect.any(String),
      id: (await publicCopyOf(entryId, releaseId)).id,
      release: { editionName: 'Deluxe', id: releaseId, releaseYear: 2019 },
      removedAt: null,
      removedOn: null,
      removeReason: null,
      retractedAt: null,
    };

    const listed = "GET /api/game-collections as the entry's owner";
    const byId = "GET /api/game-collections/:id as the entry's owner";
    const patched = "PATCH /api/game-collections/:id as the entry's owner";
    const repeated = "POST /api/game-collections again as the entry's owner";
    const { platformGameId } = await db.client.gameCollection.findUniqueOrThrow({
      where: { id: entryId },
      select: { platformGameId: true },
    });

    const rows = [
      {
        row: rowOnPage(
          listCollectionsEnvelope(await request(baseUrl).get(COLLECTIONS_PATH).set(owner.headers).expect(200), listed)
            .collections,
          entryId,
          listed,
        ),
        description: listed,
      },
      { row: (await rowById(owner, entryId, 'the owner')).row, description: byId },
      {
        row: readCollectionEnvelope(
          await request(baseUrl)
            .patch(`${COLLECTIONS_PATH}/${entryId}`)
            .set(owner.headers)
            .send({ favorite: true })
            .expect(200),
          patched,
        ).collection,
        description: patched,
      },
      {
        row: readCollectionEnvelope(
          await request(baseUrl)
            .post(COLLECTIONS_PATH)
            .set(owner.headers)
            .send({ platformGameId, medium: GameMedium.Physical })
            .expect(201),
          repeated,
        ).collection,
        description: repeated,
      },
    ];

    for (const { row, description } of rows) {
      expect({ description, copies: ownerRowCopies(row, description) }).toEqual({
        description,
        copies: [ownersCopy],
      });
    }

    // Another user's collection is read as other readers read it, even by the
    // owner: that route's rows never carry the owner's shape (#1231).
    const { row, description } = await rowListed(owner, owner.user.id, entryId, 'the owner');
    expect(publicRowCopies(row, description)).toHaveLength(1);
    expect(keysOf(row, description)).toEqual([PUBLIC_COPY_KEYS]);
  });
});
