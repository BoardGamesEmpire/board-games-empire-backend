import { FEEDBACK_QUEUE_NAME } from '@bge/queue-feedback';
import request from 'supertest';
import { resetDatabase } from '../support/database-reset';
import { requireBaseUrl } from '../support/e2e-env';
import { countPendingJobs, createTestQueue, type TestQueue } from '../support/queues';
import { createTestDatabase, type TestDatabase } from '../support/test-db';

const ISOLATION_USERNAME = 'e2e-harness-isolation';

/**
 * Acceptance for the harness itself (#255). Black-box: the API runs as its
 * own process (launched by globalSetup from the built bundle) and every
 * behavioral assertion travels over HTTP. The database and queue clients
 * below are PLUMBING — the isolation sweep and verification of state no
 * endpoint exposes — not a channel into the application. Feature suites
 * (#256/#257/#262) build on these primitives.
 */
describe('e2e harness', () => {
  const baseUrl = requireBaseUrl(process.env);

  let db: TestDatabase;
  let feedbackQueue: TestQueue;

  beforeAll(() => {
    db = createTestDatabase();
    feedbackQueue = createTestQueue(FEEDBACK_QUEUE_NAME);
  });

  afterAll(async () => {
    await feedbackQueue.close();
    await db.close();
  });

  describe('server boot', () => {
    it('serves the liveness probe outside the global prefix', async () => {
      const response = await request(baseUrl).get('/health/live');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });

    it('reports readiness against the ephemeral Postgres and Redis', async () => {
      const response = await request(baseUrl).get('/health/ready');

      // 200 covers both the full dependency check and the config-disabled
      // short-circuit; a 503 here means a container isn't actually wired.
      expect(response.status).toBe(200);
    });

    it('mounts the BetterAuth handler under the global prefix', async () => {
      // better-auth's built-in health route — present regardless of which
      // auth methods are enabled, so this pins the mount deterministically.
      const response = await request(baseUrl).get('/api/auth/ok');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ok: true });
    });

    it('accepts JSON bodies on auth routes', async () => {
      const response = await request(baseUrl)
        .post('/api/auth/sign-in/email')
        .send({})
        .set('Content-Type', 'application/json');

      // Auth semantics belong to #256; this only pins that the raw-body
      // arrangement on auth routes doesn't blow up. (404 is tolerated —
      // the route disappears when email/password auth is disabled in the
      // developer's .env.)
      expect(response.status).toBeLessThan(500);
    });

    it('rejects unauthenticated requests via the global AuthGuard', async () => {
      const response = await request(baseUrl).get('/api/households');

      expect(response.status).toBe(401);
    });
  });

  describe('migrations and seeds', () => {
    // Plumbing reads: no unauthenticated endpoint exposes the catalog, and
    // proving it over HTTP belongs to the authenticated suites (#256+).
    it('applied the reference and catalog seeds', async () => {
      const [roleCount, permissionCount, languageTagCount, platformCount, systemSettings] = await Promise.all([
        db.client.role.count(),
        db.client.permission.count(),
        db.client.languageTag.count(),
        db.client.platform.count(),
        db.client.systemSetting.findUnique({ where: { singleton: true } }),
      ]);

      expect(roleCount).toBeGreaterThan(0);
      expect(permissionCount).toBeGreaterThan(0);
      expect(languageTagCount).toBeGreaterThan(0);
      expect(platformCount).toBeGreaterThan(0);
      expect(systemSettings).not.toBeNull();
    });
  });

  describe('isolation sweep', () => {
    it('truncates mutable tables while preserving seeded reference data', async () => {
      await db.client.user.create({
        data: { username: ISOLATION_USERNAME, email: 'isolation@e2e.invalid' },
      });

      await expect(db.client.user.count({ where: { username: ISOLATION_USERNAME } })).resolves.toBe(1);

      await resetDatabase(db.client, db.schema);

      await expect(db.client.user.count()).resolves.toBe(0);
      // Reference data survives the sweep — the next test still has a catalog.
      await expect(db.client.role.count()).resolves.toBeGreaterThan(0);
      await expect(db.client.systemSetting.findUnique({ where: { singleton: true } })).resolves.not.toBeNull();
    });

    it('is applied automatically between tests by the setupFilesAfterEnv hook', async () => {
      // The previous test's manual reset proves resetDatabase itself; this
      // one proves the wiring — the row created below must be gone before
      // the NEXT test runs, without anyone calling resetDatabase by hand.
      await db.client.user.create({
        data: { username: ISOLATION_USERNAME, email: 'isolation@e2e.invalid' },
      });
    });

    it('does not leak rows written by the previous test', async () => {
      await expect(db.client.user.count({ where: { username: ISOLATION_USERNAME } })).resolves.toBe(0);
    });
  });

  describe('queues', () => {
    it('reaches registered queues with nothing consuming them', async () => {
      // No @Processor runs in the API server — enqueued jobs would sit in
      // 'waiting'. An empty count here pins the paused-by-default baseline
      // the #262 suite builds on.
      await expect(countPendingJobs(feedbackQueue.queue)).resolves.toBe(0);
    });
  });
});
