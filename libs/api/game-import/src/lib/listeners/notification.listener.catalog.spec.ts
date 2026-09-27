import { AuditContextService } from '@bge/actor-context';
import { JobStatus } from '@bge/database';
import { FALLBACK_LOCALE, I18N_CATALOG_DIR, I18nResponseInterceptor, type I18nTranslations } from '@bge/i18n';
import type { NotificationsService } from '@bge/notifications-service';
import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { I18nModule, I18nService } from 'nestjs-i18n';
import { ImportJobFailedEvent } from '../events/import.events';
import { ImportErrorCode, importErrorMessage } from '../utils/sanitize-import-error';
import { NotificationListener } from './notification.listener';

/**
 * The ImportFailed notification from the listener's write to the user's read,
 * against the REAL shipped catalog. The worker stores the row; the user reads it
 * later through `GET /notifications/unread`, behind `I18nResponseInterceptor`.
 * In between, the payload lives in a JSON column, so a marker must still be
 * recognized after `JSON.stringify` → `JSON.parse`, and must render in the
 * locale of whoever reads it, not whoever caused the failure.
 */
const stored: unknown[] = [];

@Controller('notifications')
class UnreadController {
  @Get('unread')
  unread() {
    // What Prisma hands back from the JSON column: the payload as written,
    // rehydrated as plain objects that are no longer I18nMessage instances.
    return JSON.parse(JSON.stringify(stored));
  }
}

describe('ImportFailed notification read-back (real catalog)', () => {
  let app: INestApplication;
  let i18n: I18nService<I18nTranslations>;
  const getLocale = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        I18nModule.forRoot({
          fallbackLanguage: FALLBACK_LOCALE,
          loaderOptions: { path: I18N_CATALOG_DIR, watch: false },
        }),
      ],
      controllers: [UnreadController],
      providers: [
        { provide: AuditContextService, useValue: { getLocale } },
        { provide: APP_INTERCEPTOR, useClass: I18nResponseInterceptor },
      ],
    }).compile();

    i18n = moduleRef.get(I18nService);
    app = moduleRef.createNestApplication();
    await app.listen(0);

    const notifications = {
      create: jest.fn(async (input: { payload: unknown }) => void stored.push({ payload: input.payload })),
    };
    const listener = new NotificationListener(
      notifications as unknown as NotificationsService,
      { getActor: () => ({ kind: 'user', userId: 'user-7' }) } as unknown as AuditContextService,
    );

    await listener.handleFailed(
      new ImportJobFailedEvent(
        { id: 'job-1' },
        {
          id: 'job-1',
          status: JobStatus.Failed,
          result: { errorCode: ImportErrorCode.NotFound, error: importErrorMessage(ImportErrorCode.NotFound) },
        },
        { batchId: 'batch-1', gatewayId: 'bgg', externalId: 'ext-1', isExpansion: false },
        new Date(),
      ),
    );
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => jest.restoreAllMocks());

  const readUnread = async () =>
    (await (await fetch(`${await app.getUrl()}/notifications/unread`)).json()) as {
      payload: Record<string, unknown>;
    }[];

  it('renders the stored message as the en catalog text for an en reader', async () => {
    getLocale.mockReturnValue(FALLBACK_LOCALE);

    await expect(readUnread()).resolves.toEqual([
      {
        payload: expect.objectContaining({
          errorCode: ImportErrorCode.NotFound,
          error: 'The requested game could not be found on the gateway.',
        }),
      },
    ]);
  });

  it("renders it in the reader's locale, looked up when the row is read", async () => {
    // Only `en` ships, so a real `fr` lookup would fall back to English and
    // prove nothing. The spy shows which locale the read asked for.
    const translate = jest.spyOn(i18n, 'translate').mockReturnValue('Jeu introuvable sur la passerelle.' as never);
    getLocale.mockReturnValue('fr');

    const [notification] = await readUnread();

    expect(translate).toHaveBeenCalledWith(
      'errors.game_import.failure.not_found',
      expect.objectContaining({ lang: 'fr' }),
    );
    expect(notification.payload['error']).toBe('Jeu introuvable sur la passerelle.');
  });
});
