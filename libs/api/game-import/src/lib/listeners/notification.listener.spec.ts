import type { Actor, AuditContextService } from '@bge/actor-context';
import { JobStatus, JobType, NotificationType } from '@bge/database';
import type { NotificationsService } from '@bge/notifications-service';
import { ImportJobCompletedEvent, ImportJobFailedEvent, type ImportJobCompletedContext } from '../events/import.events';
import { ImportErrorCode } from '../utils/sanitize-import-error';
import { NotificationListener } from './notification.listener';

const USER_ACTOR: Actor = { kind: 'user', userId: 'user-7' };
const SYSTEM_ACTOR: Actor = { kind: 'system', reason: 'scheduled-import' };

const makeCompleted = (ctx: Partial<ImportJobCompletedContext> = {}) =>
  new ImportJobCompletedEvent(
    { id: 'job-1', status: JobStatus.Running },
    { id: 'job-1', status: JobStatus.Completed, gameId: 'game-1' },
    {
      batchId: 'batch-1',
      gatewayId: 'bgg',
      externalId: 'ext-1',
      isExpansion: false,
      gameTitle: 'Catan',
      thumbnail: null,
      gameCreated: true,
      sourceCreated: true,
      platformGames: [],
      ...ctx,
    },
    new Date(),
  );

const makeFailed = () =>
  new ImportJobFailedEvent(
    { id: 'job-1' }, // prior status unknown at the shared emit point — identity only
    {
      id: 'job-1',
      status: JobStatus.Failed,
      result: { errorCode: ImportErrorCode.GatewayError, error: 'Fetching game data from the gateway failed.' },
    },
    { batchId: 'batch-1', gatewayId: 'bgg', externalId: 'ext-1', isExpansion: false },
    new Date(),
  );

describe('NotificationListener', () => {
  let listener: NotificationListener;
  let notifications: { create: jest.Mock };
  let auditContext: { getActor: jest.Mock };

  beforeEach(() => {
    notifications = { create: jest.fn().mockResolvedValue(undefined) };
    auditContext = { getActor: jest.fn().mockReturnValue(USER_ACTOR) };
    listener = new NotificationListener(
      notifications as unknown as NotificationsService,
      auditContext as unknown as AuditContextService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  describe('handle (JobCompleted)', () => {
    it('notifies the requesting user derived from the CLS actor', async () => {
      await listener.handle(makeCompleted());

      expect(notifications.create).toHaveBeenCalledWith({
        userId: 'user-7',
        type: NotificationType.GameImported,
        payload: {
          gameId: 'game-1',
          gameTitle: 'Catan',
          thumbnail: null,
          jobId: 'job-1',
          batchId: 'batch-1',
        },
      });
    });

    it('uses ExpansionImported for expansion imports', async () => {
      await listener.handle(makeCompleted({ isExpansion: true, baseGameId: 'base-1' }));

      expect(notifications.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: NotificationType.ExpansionImported }),
      );
    });

    it('skips when the CLS actor carries no user (system-initiated import)', async () => {
      auditContext.getActor.mockReturnValue(SYSTEM_ACTOR);
      await listener.handle(makeCompleted());
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('skips when no actor is in scope at all', async () => {
      auditContext.getActor.mockReturnValue(null);
      await listener.handle(makeCompleted());
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('skips re-imports (no new source)', async () => {
      await listener.handle(makeCompleted({ sourceCreated: false }));
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('never throws into the emitter when notification creation fails', async () => {
      notifications.create.mockRejectedValue(new Error('db down'));
      await expect(listener.handle(makeCompleted())).resolves.toBeUndefined();
    });
  });

  describe('handleFailed (JobFailed)', () => {
    it('notifies the initiating user with the sanitized classification from the Job.result snapshot', async () => {
      await listener.handleFailed(makeFailed());

      expect(notifications.create).toHaveBeenCalledWith({
        userId: 'user-7',
        type: NotificationType.ImportFailed,
        payload: {
          jobType: JobType.GameImport,
          jobId: 'job-1',
          batchId: 'batch-1',
          gatewayId: 'bgg',
          externalId: 'ext-1',
          isExpansion: false,
          errorCode: ImportErrorCode.GatewayError,
          error: 'Fetching game data from the gateway failed.',
        },
      });
    });

    it('skips when the CLS actor carries no user (system-initiated import)', async () => {
      auditContext.getActor.mockReturnValue(SYSTEM_ACTOR);
      await listener.handleFailed(makeFailed());
      expect(notifications.create).not.toHaveBeenCalled();
    });
  });
});
