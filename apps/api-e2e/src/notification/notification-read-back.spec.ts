import type { DatabaseService } from '@bge/database';
import { JobType, NotificationType } from '@bge/database';
import { t } from '@bge/i18n';
import { NotificationsService } from '@bge/notifications-service';
import type { Actors } from '@bge/testing-e2e';
import { createActors } from '@bge/testing-e2e';
import request from 'supertest';
import { requireBaseUrl } from '../support/e2e-env';
import type { TestDatabase } from '../support/test-db';
import { createTestDatabase } from '../support/test-db';
import { notificationPage, unreadNotifications } from './notification-wire';

/**
 * A notification's user-facing text is stored as a `t()` marker and rendered
 * when the user reads it back (#188). The worker that writes the row never
 * translates; `I18nResponseInterceptor` does, on `GET /notifications/unread`
 * and on the history list `GET /notifications` (#1597), in the reader's
 * locale.
 *
 * The row is written through the real `NotificationsService`, so the marker
 * takes the same path the worker's does: a class instance into a Prisma JSON
 * column, and back out as a plain object the interceptor must still recognize.
 */
describe('notification read-back', () => {
  const baseUrl = requireBaseUrl(process.env);
  const UNREAD_PATH = '/api/notifications/unread';
  const LIST_PATH = '/api/notifications';

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
    const reader = await actors.user();

    await notifications.create({
      userId: reader.user.id,
      type: NotificationType.ImportFailed,
      payload: {
        jobType: JobType.GameImport,
        jobId: 'job-1',
        batchId: 'batch-1',
        gatewayId: 'bgg',
        externalId: 'ext-1',
        origin: 'Requested',
        errorCode: 'GATEWAY_ERROR',
        error: t('errors.game_import.failure.gateway_error'),
      },
    });

    const response = await request(baseUrl).get(UNREAD_PATH).set(reader.headers).expect(200);
    const unread = unreadNotifications(response, `GET ${UNREAD_PATH}`);

    expect(unread).toHaveLength(1);
    const [notification] = unread;
    expect(notification.type).toBe(NotificationType.ImportFailed);
    expect(notification.payload['errorCode']).toBe('GATEWAY_ERROR');
    expect(notification.payload['error']).toBe('Fetching game data from the gateway failed.');

    // The history list renders the same marker the same way (#1597).
    const listResponse = await request(baseUrl).get(LIST_PATH).set(reader.headers).expect(200);
    const { notifications: listed } = notificationPage(listResponse, `GET ${LIST_PATH}`);

    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(notification.id);
    expect(listed[0].payload['errorCode']).toBe('GATEWAY_ERROR');
    expect(listed[0].payload['error']).toBe('Fetching game data from the gateway failed.');
  });
});
