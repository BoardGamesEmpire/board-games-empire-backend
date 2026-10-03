import { Visibility } from '@bge/database';
import { createActors, type Actors, type AuthenticatedActor } from '@bge/testing-e2e';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { listMediaEnvelope, readMediaEnvelope } from './media-wire';

/**
 * Which media `GET /api/media` lists, over the real routes (#514).
 *
 * The list is the caller's own media. Until #514 the caller's ceiling was the
 * whole query, so a user was also listed every other user's Public media, and
 * staff every object on the server: `read:public_content` is a read on `all`.
 * Each narrowing below follows a by-id read showing the same caller still
 * reads the media the list leaves out: narrowed out of the list, not
 * withdrawn. Without that control, a list that lost the media because the
 * caller lost all access to it would pass too.
 *
 * Rows are inserted directly: a list never reads the bytes, so none are
 * stored. No test lists for an actor before the writes that list must
 * reflect.
 */
describe('media read scope', () => {
  const baseUrl = requireBaseUrl(process.env);
  const MEDIA_PATH = '/api/media';

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  const readMedia = (actor: AuthenticatedActor, id: string) =>
    request(baseUrl).get(`${MEDIA_PATH}/${id}`).set(actor.headers);

  const listMedia = (actor: AuthenticatedActor) => request(baseUrl).get(MEDIA_PATH).set(actor.headers);

  /** A media object row owned by `ownerId`, with no bytes behind it. */
  const arrangeMedia = async (ownerId: string, visibility: Visibility) =>
    (
      await db.client.mediaObject.create({
        data: {
          ownerId,
          uploaderId: ownerId,
          visibility,
          driverSlug: 'e2e',
          driverKey: `e2e/${randomUUID()}`,
          sizeBytes: 1n,
          mimeType: 'image/png',
          checksum: 'e2e',
        },
        select: { id: true },
      })
    ).id;

  const listedPage = (actor: AuthenticatedActor, who: string) =>
    listMedia(actor)
      .expect(200)
      .then((response) => listMediaEnvelope(response, `GET /api/media as ${who}`));

  it("lists staff only their own media, while each still reads a stranger's Private media by id", async () => {
    const [serverOwner, admin, moderator, plainUser, stranger] = await Promise.all([
      actors.owner(),
      actors.admin(),
      actors.moderator(),
      actors.user(),
      actors.user(),
    ]);

    const strangersPrivate = await arrangeMedia(stranger.user.id, Visibility.Private);
    const staff = [
      ['an admin', admin, await arrangeMedia(admin.user.id, Visibility.Private)],
      ['a moderator', moderator, await arrangeMedia(moderator.user.id, Visibility.Private)],
      ["the server's Owner", serverOwner, await arrangeMedia(serverOwner.user.id, Visibility.Private)],
    ] as const;

    // The control. Admin and Moderator read the stranger's media through
    // `read:public_content`, and the Owner through `manage:all`. A plain user
    // is refused the same media, so the reads above come from the staff grants
    // and not from the media being open to everyone.
    for (const [who, actor] of staff) {
      const read = readMediaEnvelope(
        await readMedia(actor, strangersPrivate).expect(200),
        `GET /api/media/:id as ${who}`,
      );
      expect(read.media.id).toBe(strangersPrivate);
    }
    await readMedia(plainUser, strangersPrivate).expect(404);

    for (const [who, actor, ownId] of staff) {
      const page = await listedPage(actor, who);
      expect(page.media.map((media) => media.id)).toEqual([ownId]);
      expect(page.total).toBe(1);
    }
  });

  it("lists a user only their own media, while they still read another user's Public media by id", async () => {
    const user = await actors.user();
    const other = await actors.user();

    const othersPublic = await arrangeMedia(other.user.id, Visibility.Public);
    const ownPrivate = await arrangeMedia(user.user.id, Visibility.Private);
    const ownPublic = await arrangeMedia(user.user.id, Visibility.Public);

    // The control: the user reads the other user's Public media through
    // `read:media_object:public`.
    const read = readMediaEnvelope(await readMedia(user, othersPublic).expect(200), 'GET /api/media/:id as a user');
    expect(read.media.id).toBe(othersPublic);

    const page = await listedPage(user, 'a user');
    expect(page.media.map((media) => media.id).sort()).toEqual([ownPrivate, ownPublic].sort());
    expect(page.total).toBe(2);
  });
});
