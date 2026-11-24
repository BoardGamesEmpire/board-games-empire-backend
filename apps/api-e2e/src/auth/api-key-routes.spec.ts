import type { Actors, SessionActor } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import type { Caller } from '../support/api-key';
import { API_KEY_HEADER } from '../support/api-key';
import { postToAuth } from '../support/auth-routes';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import { ageStoredSession } from '../support/session-age';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';

const API_KEYS_PATH = '/api/api-keys';
const GRANTABLE_PATH = `${API_KEYS_PATH}/grantable`;
const CURRENT_PATH = `${API_KEYS_PATH}/current`;

/** A policy-checked read: `read` on `Notification`, which every user's role grants. */
const UNREAD_PATH = '/api/notifications/unread';
const READ_NOTIFICATIONS = 'read:notification:own';

/** Critical, and held by Admin alone of the roles a test actor takes. */
const UPDATE_SYSTEM_SETTING = 'update:system_setting';

/** Held by Admin, never by a plain user. */
const READ_AUDIT_LOG = 'read:audit_log';

/** Held by every user, on `Event`, a type no key scope may be pinned to. */
const READ_PUBLIC_EVENTS = 'read:event:public';

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DAY_SECONDS = DAY_MS / SECOND_MS;

/** Past better-auth's fresh-session age of a day, so a Critical permission needs a new sign-in. */
const A_DAY_AND_AN_HOUR_MS = 25 * 60 * MINUTE_MS;

/**
 * The HTTP actor middleware's 401 (`errors.api_key.invalid`) for a key better-auth's verify refuses: disabled,
 * deleted or never minted. It carries no code yet, so the English copy is what a test can assert.
 */
const INVALID_KEY_MESSAGE = 'Invalid API key';

/** An id no key ever had. Key ids are better-auth's own, not cuid2, so any string reaches the lookup. */
const MADE_UP_ID = 'no-such-api-key-id';

interface ApiKeyWire {
  readonly enabled: boolean;
  readonly expiresAt: string | null;
  readonly id: string;
  readonly name: string | null;
  readonly scopes: readonly { readonly resourceId: string | null; readonly slug: string }[];
}

/**
 * The user-managed API key routes (#1418): create, list, read, edit and delete
 * at `/api/api-keys`, the calling key's own `/current`, and better-auth's old
 * `/api/auth/api-key/*` routes, now closed.
 *
 * Each refusal is asserted with its code, inside the api's error envelope. A
 * denial a key gets after an edit has its control in the same test: the key
 * passes the same request first, so the refusal is the edit's doing.
 */
describe('API key routes (#1418)', () => {
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

  const create = (owner: Caller, body: Record<string, unknown>) =>
    request(baseUrl).post(API_KEYS_PATH).set(owner.headers).send(body);

  /** A key `owner` creates with `body`, which must succeed; its view, and the key to send it as. */
  const createKey = async (owner: Caller, body: Record<string, unknown>) => {
    const response = await create(owner, body);

    if (response.status !== 201) {
      throw new Error(`creating a key failed: ${response.status} ${JSON.stringify(response.body)}`);
    }

    const apiKey: ApiKeyWire = response.body.apiKey;

    return { apiKey, key: { headers: { [API_KEY_HEADER]: response.body.secret as string } } satisfies Caller };
  };

  const notificationsKey = (owner: Caller) =>
    createKey(owner, { name: 'notifications', scopes: [{ slug: READ_NOTIFICATIONS }] });

  const readKey = (owner: Caller, id: string) => request(baseUrl).get(`${API_KEYS_PATH}/${id}`).set(owner.headers);

  const editKey = (owner: Caller, id: string, body: Record<string, unknown>) =>
    request(baseUrl).patch(`${API_KEYS_PATH}/${id}`).set(owner.headers).send(body);

  const deleteKey = (owner: Caller, id: string) => request(baseUrl).delete(`${API_KEYS_PATH}/${id}`).set(owner.headers);

  const readUnread = (caller: Caller) => request(baseUrl).get(UNREAD_PATH).set(caller.headers);

  const slugsOf = (apiKey: ApiKeyWire) => apiKey.scopes.map(({ slug }) => slug);

  const countKeysOf = (owner: SessionActor) => db.client.apikey.count({ where: { referenceId: owner.user.id } });

  /** Whether `iso` falls within a minute either side of `days` days from now. */
  const expectDaysAhead = (iso: string | null, days: number) => {
    expect(iso).not.toBeNull();

    const offset = new Date(iso ?? 0).getTime() - (Date.now() + days * DAY_MS);
    expect(Math.abs(offset)).toBeLessThan(MINUTE_MS);
  };

  describe('create', () => {
    it('answers the secret once, and the key works for its key scope (#1418)', async () => {
      const owner = await actors.user();

      const response = await create(owner, { name: 'notifications', scopes: [{ slug: READ_NOTIFICATIONS }] });

      expect(response.status).toBe(201);
      expect(typeof response.body.secret).toBe('string');
      expect(response.body.apiKey).toEqual(
        expect.objectContaining({
          name: 'notifications',
          enabled: true,
          scopes: [{ slug: READ_NOTIFICATIONS, resourceId: null }],
        }),
      );

      await readUnread({ headers: { [API_KEY_HEADER]: response.body.secret } }).expect(200);

      // Read back, the key carries no secret: the create answer was the only time.
      const read = await readKey(owner, response.body.apiKey.id).expect(200);
      expect(read.body.apiKey).not.toHaveProperty('secret');
      expect(read.body.apiKey).not.toHaveProperty('key');
      expect(JSON.stringify(read.body)).not.toContain(response.body.secret);
    });

    it('expires a key 90 days ahead when no expiresInDays is given (#1418)', async () => {
      const { apiKey } = await notificationsKey(await actors.user());

      expectDaysAhead(apiKey.expiresAt, 90);
    });

    it('accepts expiresInDays of 1 and 365 (#1418)', async () => {
      const owner = await actors.user();

      const [oneDay, oneYear] = [
        await createKey(owner, { name: 'one day', expiresInDays: 1 }),
        await createKey(owner, { name: 'one year', expiresInDays: 365 }),
      ];

      expectDaysAhead(oneDay.apiKey.expiresAt, 1);
      expectDaysAhead(oneYear.apiKey.expiresAt, 365);
    });

    it('refuses expiresInDays of 0, 366 and -1 with 422 API_KEY_EXPIRY_OUT_OF_RANGE, naming the range (#1418)', async () => {
      const owner = await actors.user();

      for (const expiresInDays of [0, 366, -1]) {
        const response = await create(owner, { name: 'out of range', expiresInDays });

        expectErrorEnvelope(response, { status: 422, code: 'API_KEY_EXPIRY_OUT_OF_RANGE' });
        expect({ expiresInDays, min: response.body.min, max: response.body.max }).toEqual({
          expiresInDays,
          min: 1,
          max: 365,
        });
      }

      await expect(countKeysOf(owner)).resolves.toBe(0);
    });

    // Each scalar is read as sent: the global pipe's implicit conversion would
    // make "90" the number 90, and "false" true, which would confirm a
    // Critical permission the owner meant to refuse.
    it('refuses a fraction or a string for expiresInDays, and the string "false" for confirmCritical, with the 400 validation answer (#1418)', async () => {
      const admin = await actors.admin();

      for (const body of [
        { name: 'fraction', expiresInDays: 1.5 },
        { name: 'string', expiresInDays: '90' },
        { name: 'critical', scopes: [{ slug: UPDATE_SYSTEM_SETTING }], confirmCritical: 'false' },
      ]) {
        const response = await create(admin, body);

        expectErrorEnvelope(response, { status: 400, code: null });
        expect(Array.isArray(response.body.message)).toBe(true);
      }

      await expect(countKeysOf(admin)).resolves.toBe(0);
    });

    it('refuses a name of 33 characters, or of only spaces, with the 400 validation answer before a key is written (#1418)', async () => {
      const owner = await actors.user();

      for (const name of ['a'.repeat(33), '   ']) {
        expectErrorEnvelope(await create(owner, { name }), { status: 400, code: null });
      }

      await expect(countKeysOf(owner)).resolves.toBe(0);
    });

    it('refuses a permission the owner does not hold with 422 API_KEY_SCOPE_NOT_GRANTABLE, naming the slug (#1418)', async () => {
      const owner = await actors.user();

      const response = await create(owner, { name: 'audit', scopes: [{ slug: READ_AUDIT_LOG }] });

      expectErrorEnvelope(response, { status: 422, code: 'API_KEY_SCOPE_NOT_GRANTABLE' });
      expect(response.body.slug).toBe(READ_AUDIT_LOG);
      await expect(countKeysOf(owner)).resolves.toBe(0);
    });

    // The owner holds read:event:public, so the refusal is the pin's, not the slug's.
    it('refuses a pin on an Event permission with 422 API_KEY_SCOPE_NOT_PINNABLE, naming the slug (#1418)', async () => {
      const owner = await actors.user();

      const response = await create(owner, {
        name: 'pinned event',
        scopes: [{ slug: READ_PUBLIC_EVENTS, resourceId: 'some-event-id' }],
      });

      expectErrorEnvelope(response, { status: 422, code: 'API_KEY_SCOPE_NOT_PINNABLE' });
      expect(response.body.slug).toBe(READ_PUBLIC_EVENTS);
      await createKey(owner, { name: 'unpinned event', scopes: [{ slug: READ_PUBLIC_EVENTS }] });
    });

    it('refuses scopes beside the everything preset with 422 API_KEY_SCOPES_OR_PRESET (#1418)', async () => {
      const owner = await actors.user();

      const response = await create(owner, {
        name: 'both',
        scopes: [{ slug: READ_NOTIFICATIONS }],
        preset: 'everything',
      });

      expectErrorEnvelope(response, { status: 422, code: 'API_KEY_SCOPES_OR_PRESET' });
      await expect(countKeysOf(owner)).resolves.toBe(0);
    });

    describe("an Admin's key with a Critical permission", () => {
      const criticalBody = { name: 'settings', scopes: [{ slug: UPDATE_SYSTEM_SETTING }] };

      it('without confirmCritical gets 422 API_KEY_CRITICAL_NEEDS_CONFIRMATION (#1418)', async () => {
        const admin = await actors.admin();

        expectErrorEnvelope(await create(admin, criticalBody), {
          status: 422,
          code: 'API_KEY_CRITICAL_NEEDS_CONFIRMATION',
        });
        await expect(countKeysOf(admin)).resolves.toBe(0);
      });

      // A session left open must not mint a Critical key: past a day, the owner signs in again.
      it('confirmed, from a session signed in 25 hours ago, gets 403 API_KEY_NEEDS_RECENT_SIGN_IN (#1418)', async () => {
        const admin = await actors.admin();
        await ageStoredSession(sessionToken(admin.credentials.token), A_DAY_AND_AN_HOUR_MS);

        // The aged session still signs its user in: the refusal is the Critical rule's.
        await request(baseUrl).get(API_KEYS_PATH).set(admin.headers).expect(200);

        expectErrorEnvelope(await create(admin, { ...criticalBody, confirmCritical: true }), {
          status: 403,
          code: 'API_KEY_NEEDS_RECENT_SIGN_IN',
        });
        await expect(countKeysOf(admin)).resolves.toBe(0);
      });

      it('confirmed, from a fresh session, is created (#1418)', async () => {
        const admin = await actors.admin();

        const { apiKey } = await createKey(admin, { ...criticalBody, confirmCritical: true });

        expect(slugsOf(apiKey)).toEqual([UPDATE_SYSTEM_SETTING]);
      });
    });

    // A permission on `all` reaches every type, so the preset never gives a
    // key one, though the Admin holds read:public_content. The Admin never
    // holds manage:all (the Owner does), so read:public_content carries the test.
    it("gives an Admin's everything key no permission on all, and asks for confirmCritical (#1418)", async () => {
      const admin = await actors.admin();

      expectErrorEnvelope(await create(admin, { name: 'everything', preset: 'everything' }), {
        status: 422,
        code: 'API_KEY_CRITICAL_NEEDS_CONFIRMATION',
      });

      const { apiKey } = await createKey(admin, { name: 'everything', preset: 'everything', confirmCritical: true });
      const read = await readKey(admin, apiKey.id).expect(200);
      const slugs = slugsOf(read.body.apiKey);

      expect(slugs).toEqual(expect.arrayContaining([UPDATE_SYSTEM_SETTING, READ_AUDIT_LOG, READ_NOTIFICATIONS]));
      expect(slugs).not.toContain('manage:all');
      expect(slugs).not.toContain('read:public_content');
      expect(
        read.body.apiKey.scopes.every(({ resourceId }: { resourceId: string | null }) => resourceId === null),
      ).toBe(true);
    });
  });

  describe('list and read', () => {
    it("lists only the caller's keys, a page at a time, never with a secret (#1418)", async () => {
      const [owner, other] = [await actors.user(), await actors.user()];
      const ids = [
        (await createKey(owner, { name: 'first' })).apiKey.id,
        (await createKey(owner, { name: 'second' })).apiKey.id,
        (await createKey(owner, { name: 'third' })).apiKey.id,
      ];
      await createKey(other, { name: 'not yours' });

      const first = await request(baseUrl).get(API_KEYS_PATH).query({ limit: 2 }).set(owner.headers).expect(200);
      const second = await request(baseUrl)
        .get(API_KEYS_PATH)
        .query({ limit: 2, page: 2 })
        .set(owner.headers)
        .expect(200);

      expect(first.body.pagination).toEqual(expect.objectContaining({ total: 3, totalPages: 2, hasMore: true }));
      expect(second.body.pagination).toEqual(expect.objectContaining({ total: 3, hasMore: false }));

      const listed: ApiKeyWire[] = [...first.body.apiKeys, ...second.body.apiKeys];
      expect(listed.map(({ id }) => id).sort()).toEqual([...ids].sort());

      for (const apiKey of listed) {
        expect(apiKey).not.toHaveProperty('key');
        expect(apiKey).not.toHaveProperty('secret');
      }
    });

    // Another user's key gets the answer a made-up id gets, so a caller
    // can't learn which ids exist.
    it("answers 404 API_KEY_NOT_FOUND to GET, PATCH and DELETE on another user's key, or a made-up id, and changes nothing (#1418)", async () => {
      const [owner, intruder] = [await actors.user(), await actors.user()];
      const { apiKey, key } = await notificationsKey(owner);

      for (const id of [apiKey.id, MADE_UP_ID]) {
        for (const response of [
          await readKey(intruder, id),
          await editKey(intruder, id, { name: 'taken', enabled: false }),
          await deleteKey(intruder, id),
        ]) {
          expectErrorEnvelope(response, { status: 404, code: 'API_KEY_NOT_FOUND' });
        }
      }

      const read = await readKey(owner, apiKey.id).expect(200);
      expect(read.body.apiKey).toEqual(expect.objectContaining({ name: 'notifications', enabled: true }));
      await readUnread(key).expect(200);
    });
  });

  describe('edit', () => {
    // The key's scope graph is cached on its first request. Without the
    // eviction, the cached graph would still hold read:notification:own.
    it('replacing the key scopes with [] refuses the same key on its next request: its cached graph was evicted (#1418)', async () => {
      const owner = await actors.user();
      const { apiKey, key } = await notificationsKey(owner);
      await readUnread(key).expect(200);

      const edited = await editKey(owner, apiKey.id, { scopes: [] }).expect(200);

      expect(edited.body.apiKey.scopes).toEqual([]);
      await readUnread(key).expect(403);
    });

    it('enabled: false refuses the key with 401 on its next request, and enabled: true serves it again (#1418)', async () => {
      const owner = await actors.user();
      const { apiKey, key } = await notificationsKey(owner);
      await readUnread(key).expect(200);

      await editKey(owner, apiKey.id, { enabled: false }).expect(200);
      const refused = await readUnread(key);

      expectErrorEnvelope(refused, { status: 401, code: null });
      expect(refused.body.message).toBe(INVALID_KEY_MESSAGE);

      await editKey(owner, apiKey.id, { enabled: true }).expect(200);
      await readUnread(key).expect(200);
    });

    it('expiresInDays: 30 moves the expiry to 30 days from now (#1418)', async () => {
      const owner = await actors.user();
      const { apiKey } = await notificationsKey(owner);

      const edited = await editKey(owner, apiKey.id, { expiresInDays: 30 }).expect(200);

      expectDaysAhead(edited.body.apiKey.expiresAt, 30);
      expectDaysAhead((await readKey(owner, apiKey.id).expect(200)).body.apiKey.expiresAt, 30);
    });

    it('refuses a name of 33 characters with the 400 validation answer, and keeps the name (#1418)', async () => {
      const owner = await actors.user();
      const { apiKey } = await notificationsKey(owner);

      expectErrorEnvelope(await editKey(owner, apiKey.id, { name: 'a'.repeat(33) }), { status: 400, code: null });

      expect((await readKey(owner, apiKey.id).expect(200)).body.apiKey.name).toBe('notifications');
    });
  });

  describe('delete', () => {
    it('refuses the key with 401 from its next request (#1418)', async () => {
      const owner = await actors.user();
      const { apiKey, key } = await notificationsKey(owner);
      await readUnread(key).expect(200);

      await deleteKey(owner, apiKey.id).expect(200);
      const refused = await readUnread(key);

      expectErrorEnvelope(refused, { status: 401, code: null });
      expect(refused.body.message).toBe(INVALID_KEY_MESSAGE);
      expectErrorEnvelope(await readKey(owner, apiKey.id), { status: 404, code: 'API_KEY_NOT_FOUND' });
    });
  });

  // A key acts for its owner but is not the owner: a key of any key scope
  // could otherwise mint a wider or longer-lived one.
  describe('a key at the key routes', () => {
    it('gets 403 API_KEY_SESSION_REQUIRED listing keys, creating one, and reading what a key may hold (#1418)', async () => {
      const owner = await actors.user();
      const { key } = await notificationsKey(owner);

      for (const response of [
        await request(baseUrl).get(API_KEYS_PATH).set(key.headers),
        await create(key, { name: 'from a key', scopes: [{ slug: READ_NOTIFICATIONS }] }),
        await request(baseUrl).get(GRANTABLE_PATH).set(key.headers),
      ]) {
        expectErrorEnvelope(response, { status: 403, code: 'API_KEY_SESSION_REQUIRED' });
      }

      await expect(countKeysOf(owner)).resolves.toBe(1);
    });
  });

  describe('/current', () => {
    it('a key reads its own expiry, the seconds left until it, and its key scopes (#1418)', async () => {
      const startedAt = Date.now();
      const { apiKey, key } = await notificationsKey(await actors.user());

      const response = await request(baseUrl).get(CURRENT_PATH).set(key.headers).expect(200);
      const elapsedSeconds = Math.ceil((Date.now() - startedAt) / SECOND_MS);
      const current = response.body.apiKey;

      expect(current).toEqual(
        expect.objectContaining({
          id: apiKey.id,
          expiresAt: apiKey.expiresAt,
          scopes: [{ slug: READ_NOTIFICATIONS, resourceId: null }],
        }),
      );
      expect(current).not.toHaveProperty('secret');

      // The server works out both ends, so the bounds hold whatever this clock says.
      expect(Number.isInteger(current.secondsRemaining)).toBe(true);
      expect(current.secondsRemaining).toBeLessThanOrEqual(90 * DAY_SECONDS);
      expect(current.secondsRemaining).toBeGreaterThanOrEqual(90 * DAY_SECONDS - elapsedSeconds - 1);
      expect(current.secondsRemaining).toBeGreaterThan(89 * DAY_SECONDS);
    });

    it('a session gets 403 API_KEY_REQUIRED (#1418)', async () => {
      const owner = await actors.user();

      expectErrorEnvelope(await request(baseUrl).get(CURRENT_PATH).set(owner.headers), {
        status: 403,
        code: 'API_KEY_REQUIRED',
      });
    });
  });

  /**
   * better-auth's own key routes would create, edit or delete a key past the
   * owner's grantable check, so they answer 404 with a code that points to
   * `/api/api-keys`. Only the routes better-auth registers reach its before
   * hook: verify has no path, and an unknown path gets better-auth's own 404.
   */
  describe("better-auth's old key routes", () => {
    it('answers 404 API_KEY_ROUTES_MOVED to a signed-in user on create, get, list, update and delete, and writes nothing (#1418)', async () => {
      const owner = await actors.user();
      const { apiKey, key } = await notificationsKey(owner);
      const keysBefore = await countKeysOf(owner);

      const responses = {
        create: await postToAuth(baseUrl, '/api/auth/api-key/create')
          .set(owner.headers)
          .send({ name: 'past the check', permissions: { [READ_AUDIT_LOG]: ['read'] } }),
        get: await request(baseUrl).get('/api/auth/api-key/get').query({ id: apiKey.id }).set(owner.headers),
        list: await request(baseUrl).get('/api/auth/api-key/list').set(owner.headers),
        update: await postToAuth(baseUrl, '/api/auth/api-key/update')
          .set(owner.headers)
          .send({ keyId: apiKey.id, enabled: false }),
        delete: await postToAuth(baseUrl, '/api/auth/api-key/delete').set(owner.headers).send({ keyId: apiKey.id }),
      };

      for (const [route, response] of Object.entries(responses)) {
        expect({ route, status: response.status, code: response.body?.code }).toEqual({
          route,
          status: 404,
          code: 'API_KEY_ROUTES_MOVED',
        });
      }

      await expect(countKeysOf(owner)).resolves.toBe(keysBefore);
      await readUnread(key).expect(200);
    });
  });
});

/** The session id a bearer credential carries: better-auth's `<token>.<signature>`, URL-encoded when signed. */
function sessionToken(credential: string): string {
  return decodeURIComponent(credential).split('.')[0];
}
