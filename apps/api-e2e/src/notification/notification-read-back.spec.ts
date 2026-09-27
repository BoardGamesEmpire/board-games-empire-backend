import { JobType, NotificationType, type DatabaseService } from '@bge/database';
import { t } from '@bge/i18n';
import { NotificationsService } from '@bge/notifications-service';
import { createActors, type Actors } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import { createTestDatabase, type TestDatabase } from '../support/test-db';
import { unreadNotifications } from './notification-wire';

/**
 * A notification's user-facing text is stored as a `t()` marker and rendered
 * when the user reads it back (#188). The worker that writes the row never
 * translates; `I18nResponseInterceptor` does, on `GET /notifications/unread`,
 * in the reader's locale.
 *
 * The row is written through the real `NotificationsService`, so the marker
 * takes the same path the worker's does: a class instance into a Prisma JSON
 * column, and back out as a plain object the interceptor must still recognize.
 */
describe('notification read-back', () => {
  const baseUrl = requireBaseUrl(process.env);
  const UNREAD_PATH = '/api/notifications/unread';

  let db: TestDatabase;
  let actors: Actors;
  let notifications: NotificationsService;

  beforeAll(() => {
    db = createTestDatabase();
    actors = createActors({ baseUrl, prisma: db.client });
    notifications = new NotificationsService(db.client as unknown as DatabaseService);
  });

  afterAll(async () => {
    await db.close();
  });

  it('renders an ImportFailed message stored as a marker to its text, and keeps the code', async () => {
    // An admin reading their own notification. No role grants a plain user
    // `read` on Notification yet, so a user is refused before any row is read
    // (#504); staff pass through their `read` on `all`. The route still returns
    // only the caller's rows. Switch to `actors.user()` once #504 lands.
    const reader = await actors.admin();

    await notifications.create({
      userId: reader.user.id,
      type: NotificationType.ImportFailed,
      payload: {
        jobType: JobType.GameImport,
        jobId: 'job-1',
        batchId: 'batch-1',
        gatewayId: 'bgg',
        externalId: 'ext-1',
        isExpansion: false,
        errorCode: 'GATEWAY_ERROR',
        error: t('errors.game_import.failure.gateway_error'),
      },
    });

    const response = await request(baseUrl).get(UNREAD_PATH).set(reader.headers).expect(200);
    // Staff also receive audit alerts, so pick the row out by type.
    const importFailures = unreadNotifications(response, `GET ${UNREAD_PATH}`).filter(
      (unread) => unread.type === NotificationType.ImportFailed,
    );

    expect(importFailures).toHaveLength(1);
    const [notification] = importFailures;
    expect(notification.payload['errorCode']).toBe('GATEWAY_ERROR');
    expect(notification.payload['error']).toBe('Fetching game data from the gateway failed.');
  });
});
