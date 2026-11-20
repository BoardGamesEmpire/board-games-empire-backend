import type { Prisma } from '@bge/database';
import { AuthType, constraintIdentity, ResourceType, SyncStatus, Upstream } from '@bge/database';
import type { Actors, SessionActor } from '@bge/testing-e2e';
import { createActors, pollUntil } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { expectErrorEnvelope } from '../support/error-envelope';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';

/**
 * A user's own upstream accounts on the wire (#935): the list, with the
 * upstreams a user can link an account at and the privacy policy a client
 * shows first (#934); unlinking one; and the two uniques Postgres holds the
 * accounts to.
 *
 * No DataGateway declares an upstream until #930 lands, so the rows here are
 * seeded straight into the database. No coordinator runs either: an enabled
 * row written to the table connects to nothing, since the api reads enabled
 * DataGateways only at its start.
 */
describe('upstream accounts (#935)', () => {
  const baseUrl = requireBaseUrl(process.env);
  const PATH = '/api/users/me/upstream-accounts';
  const STEAM_PATH = `${PATH}/steam`;

  /** A SteamID64 of the form Steam answers with. */
  const STEAM_ID = '76561197960287930';

  /** The audit listener writes after the response; generous for a loaded CI runner. */
  const AUDIT_ROW_LANDS_MS = 5_000;

  const UNLINKED = 'upstream_account.unlinked';

  /** A remote DataGateway's connection fields; nothing connects to them here. */
  const CONNECTION = { connectionUrl: 'localhost', connectionPort: 50099, authType: AuthType.None } as const;

  let db: TestDatabase;
  let actors: Actors;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
  });

  afterAll(async () => {
    await db.close();
  });

  let seq = 0;

  /** A DataGateway that declares `upstream`, enabled unless `data` says otherwise. */
  const seedDataGateway = (upstream: Upstream, data: Partial<Prisma.DataGatewayUncheckedCreateInput> = {}) =>
    db.client.dataGateway.create({
      data: { name: `Upstream Gateway ${++seq}`, upstream, enabled: true, ...CONNECTION, ...data },
    });

  /** An upstream account for `user`, a verified Steam one unless `data` says otherwise. */
  const seedAccount = (user: SessionActor, data: Partial<Prisma.UpstreamAccountUncheckedCreateInput> = {}) =>
    db.client.upstreamAccount.create({
      data: {
        userId: user.user.id,
        upstream: Upstream.Steam,
        externalId: STEAM_ID,
        profileUrl: `https://steamcommunity.com/profiles/${STEAM_ID}`,
        verified: true,
        ...data,
      },
    });

  const list = (user: SessionActor) => request(baseUrl).get(PATH).set(user.headers).expect(200);

  /** The policy `GET /api/privacy-policy` serves someone who is not signed in. */
  const servedPolicy = async (): Promise<{ language: string; updatedAt: string }> => {
    const response = await request(baseUrl).get('/api/privacy-policy').expect(200);

    return { language: response.body.privacyPolicy.language, updatedAt: response.body.privacyPolicy.updatedAt };
  };

  const failureOf = (attempt: Promise<unknown>) => attempt.then(() => undefined).catch((err: unknown) => err);

  /** The SQLSTATE Postgres reports a unique violation with. */
  const SQLSTATE_UNIQUE_VIOLATION = '23505';

  describe('the list', () => {
    // The first read is the control for the second: without a DataGateway
    // nothing is linkable, so the `steam` after the seed comes from the seed.
    // Two reads of one route also show the answer is not served from a cache.
    it('lists no accounts, the upstreams an enabled DataGateway declares, and the privacy policy (#935)', async () => {
      const user = await actors.user();
      const policy = await servedPolicy();

      await expect(list(user)).resolves.toMatchObject({
        body: { upstreamAccounts: [], linkableUpstreams: [] },
      });

      // IGDB is declared too, but this server has no way to link an account
      // there, so offering it would offer a link every attempt refuses.
      await seedDataGateway(Upstream.IGDB);
      await seedDataGateway(Upstream.Steam);

      const response = await list(user);

      expect(response.body).toEqual({
        upstreamAccounts: [],
        linkableUpstreams: ['steam'],
        privacyPolicy: { url: '/api/privacy-policy', language: policy.language, updatedAt: policy.updatedAt },
      });
    });

    it('leaves out a disabled or deleted DataGateway’s upstream (#935)', async () => {
      const user = await actors.user();
      const disabled = await seedDataGateway(Upstream.Steam, { enabled: false });
      await seedDataGateway(Upstream.Steam, { deletedAt: new Date() });

      await expect(list(user)).resolves.toMatchObject({ body: { linkableUpstreams: [] } });

      // The control: the same row, enabled, makes Steam linkable.
      await db.client.dataGateway.update({ where: { id: disabled.id }, data: { enabled: true } });

      await expect(list(user)).resolves.toMatchObject({ body: { linkableUpstreams: ['steam'] } });
    });

    // An account stays when no DataGateway declares its upstream any more,
    // and the answer names it by key, without the row's or the user's id.
    it('lists the user’s own account and not another user’s, with no DataGateway for its upstream (#935)', async () => {
      const [user, other] = await Promise.all([actors.user(), actors.user()]);
      const account = await seedAccount(user);
      await seedAccount(other, { externalId: '76561197960287931', verified: false });

      const response = await list(user);

      expect(response.body.upstreamAccounts).toEqual([
        {
          upstream: 'steam',
          externalId: STEAM_ID,
          displayName: null,
          profileUrl: `https://steamcommunity.com/profiles/${STEAM_ID}`,
          verified: true,
          linkedAt: account.createdAt.toISOString(),
        },
      ]);
      expect(response.body.linkableUpstreams).toEqual([]);
    });

    it('refuses someone who is not signed in (#935)', async () => {
      expectErrorEnvelope(await request(baseUrl).get(PATH), { status: 401, code: 'UNAUTHORIZED' });
    });
  });

  describe('unlinking', () => {
    /** The account's audit entries, oldest first, once one for `event` has been written. */
    const auditEntriesOnceOneIs = (subjectId: string, event: string) =>
      pollUntil(
        async () => {
          const entries = await db.client.auditLog.findMany({
            where: { subject: ResourceType.UpstreamAccount, subjectId },
            orderBy: { occurredAt: 'asc' },
          });

          return entries.some((entry) => entry.event === event) ? entries : undefined;
        },
        { description: `the ${event} audit entry for upstream account ${subjectId}`, timeoutMs: AUDIT_ROW_LANDS_MS },
      );

    it('unlinks the user’s own account, deletes its sync logs, and audits it (#935)', async () => {
      const [user, other] = await Promise.all([actors.user(), actors.user()]);
      const account = await seedAccount(user);
      // Another user's claim to the same SteamID, at the same upstream: the
      // unlink must leave it.
      const othersAccount = await seedAccount(other, { verified: false });
      await db.client.upstreamAccountSyncLog.create({
        data: { accountId: account.id, startedAt: new Date(), status: SyncStatus.Success },
      });

      const response = await request(baseUrl).delete(STEAM_PATH).set(user.headers).expect(200);

      expect(response.body).toEqual({ message: expect.stringContaining('Steam') });
      await expect(db.client.upstreamAccount.count({ where: { id: account.id } })).resolves.toBe(0);
      await expect(db.client.upstreamAccountSyncLog.count({ where: { accountId: account.id } })).resolves.toBe(0);
      await expect(db.client.upstreamAccount.count({ where: { id: othersAccount.id } })).resolves.toBe(1);
      const entries = await auditEntriesOnceOneIs(account.id, UNLINKED);

      expect(entries).toEqual([
        expect.objectContaining({
          action: 'delete',
          actorUserId: user.user.id,
          event: UNLINKED,
          payload: {
            before: expect.objectContaining({ id: account.id, upstream: Upstream.Steam, verified: true }),
            after: null,
          },
        }),
      ]);
      // Unlinking deletes the SteamID, as the privacy policy says, so the
      // audit entry that outlives the account keeps neither it nor the
      // profile address that carries it (#935).
      expect(JSON.stringify(entries[0].payload)).not.toContain(STEAM_ID);

      // Nothing is left to unlink.
      expectErrorEnvelope(await request(baseUrl).delete(STEAM_PATH).set(user.headers), {
        status: 404,
        code: 'UPSTREAM_ACCOUNT_NOT_FOUND',
      });
    });

    it('answers UPSTREAM_ACCOUNT_NOT_FOUND when there is nothing to unlink, and never touches another user’s (#935)', async () => {
      const [user, other] = await Promise.all([actors.user(), actors.user()]);
      const othersAccount = await seedAccount(other);

      expectErrorEnvelope(await request(baseUrl).delete(STEAM_PATH).set(user.headers), {
        status: 404,
        code: 'UPSTREAM_ACCOUNT_NOT_FOUND',
      });
      await expect(db.client.upstreamAccount.count({ where: { id: othersAccount.id } })).resolves.toBe(1);
    });

    // A path names an upstream by its well-known key; the enum's own spelling
    // is not one.
    it('answers UPSTREAM_UNKNOWN for a key that names no upstream, and 401 to someone not signed in (#935)', async () => {
      const user = await actors.user();
      await seedAccount(user);

      expectErrorEnvelope(await request(baseUrl).delete(`${PATH}/Steam`).set(user.headers), {
        status: 400,
        code: 'UPSTREAM_UNKNOWN',
      });
      expectErrorEnvelope(await request(baseUrl).delete(STEAM_PATH), { status: 401, code: 'UNAUTHORIZED' });
      await expect(db.client.upstreamAccount.count({ where: { userId: user.user.id } })).resolves.toBe(1);
    });
  });

  // The two uniques are Postgres's, so two links at once can't both pass a
  // check made first (#935). Written straight to the table, as a link that
  // raced past the routes' own checks would write them.
  describe('the table', () => {
    it('holds a verified external id to one user, and lets unverified ones repeat (#935)', async () => {
      const [first, second, third] = await Promise.all([actors.user(), actors.user(), actors.user()]);
      await seedAccount(first);

      const failure = await failureOf(seedAccount(second));

      expect(failure).toMatchObject({ code: 'P2002' });
      // The identity `UpstreamAccountService` reads to answer
      // UPSTREAM_ACCOUNT_TAKEN: the index name the migration gives it, as the
      // driver adapter reports it on this stack.
      expect(constraintIdentity(failure)).toEqual({
        source: 'driverAdapterError.index',
        names: ['upstream_accounts_verified_external_id'],
        sqlState: SQLSTATE_UNIQUE_VIOLATION,
      });

      // Unverified accounts are claims: the same id may sit beside the
      // verified one, and beside each other.
      await seedAccount(second, { verified: false });
      await seedAccount(third, { verified: false });

      await expect(db.client.upstreamAccount.count({ where: { externalId: STEAM_ID } })).resolves.toBe(3);
    });

    it('holds one account per user per upstream (#935)', async () => {
      const user = await actors.user();
      await seedAccount(user, { verified: false });

      const failure = await failureOf(seedAccount(user, { externalId: '76561197960287931', verified: false }));

      expect(failure).toMatchObject({ code: 'P2002' });
      // The identity `UpstreamAccountService` reads to answer
      // UPSTREAM_ACCOUNT_ALREADY_LINKED: the name Prisma gives the unique.
      expect(constraintIdentity(failure)).toEqual({
        source: 'driverAdapterError.index',
        names: ['upstream_accounts_user_id_upstream_key'],
        sqlState: SQLSTATE_UNIQUE_VIOLATION,
      });

      // The control: the same user at another upstream.
      await seedAccount(user, { upstream: Upstream.BoardGameGeek, externalId: 'boardgamer', profileUrl: null });

      await expect(db.client.upstreamAccount.count({ where: { userId: user.user.id } })).resolves.toBe(2);
    });
  });
});
