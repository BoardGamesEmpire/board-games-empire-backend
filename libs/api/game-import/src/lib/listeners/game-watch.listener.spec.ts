import type { Actor, AuditContextService } from '@bge/actor-context';
import { JobStatus, NotificationType, type DatabaseService } from '@bge/database';
import type { NotificationsService } from '@bge/notifications-service';
import { ImportJobCompletedEvent, type ImportJobCompletedContext } from '../events/import.events';
import { GameWatchListener } from './game-watch.listener';

const USER_ACTOR: Actor = { kind: 'user', userId: 'user-7' };

const makeExpansionCompleted = (ctx: Partial<ImportJobCompletedContext> = {}) =>
  new ImportJobCompletedEvent(
    { id: 'job-1', status: JobStatus.Running },
    { id: 'job-1', status: JobStatus.Completed, gameId: 'exp-game-1' },
    {
      batchId: 'batch-1',
      gatewayId: 'bgg',
      externalId: 'ext-1',
      isExpansion: true,
      gameTitle: 'Seafarers',
      thumbnail: null,
      gameCreated: true,
      sourceCreated: true,
      platformGames: [],
      baseGameId: 'base-game-1',
      ...ctx,
    },
    new Date(),
  );

describe('GameWatchListener', () => {
  let listener: GameWatchListener;
  let db: { gameWatch: { findMany: jest.Mock } };
  let notifications: { createMany: jest.Mock };
  let auditContext: { getActor: jest.Mock };

  beforeEach(() => {
    db = { gameWatch: { findMany: jest.fn().mockResolvedValue([]) } };
    notifications = { createMany: jest.fn().mockResolvedValue(undefined) };
    auditContext = { getActor: jest.fn().mockReturnValue(USER_ACTOR) };
    listener = new GameWatchListener(
      db as unknown as DatabaseService,
      notifications as unknown as NotificationsService,
      auditContext as unknown as AuditContextService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('notifies watchers of the base game, excluding the importing CLS user', async () => {
    db.gameWatch.findMany.mockResolvedValue([
      { userId: 'user-7', game: { title: 'Catan' } },
      { userId: 'watcher-1', game: { title: 'Catan' } },
    ]);

    await listener.handle(makeExpansionCompleted());

    expect(db.gameWatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { gameId: 'base-game-1' } }),
    );
    expect(notifications.createMany).toHaveBeenCalledWith([
      {
        userId: 'watcher-1',
        type: NotificationType.WatchedExpansionImported,
        payload: {
          gameId: 'exp-game-1',
          gameTitle: 'Seafarers',
          thumbnail: null,
          baseGameId: 'base-game-1',
          baseGameTitle: 'Catan',
        },
      },
    ]);
  });

  it('notifies every watcher when the import was system-initiated (no user actor)', async () => {
    auditContext.getActor.mockReturnValue(null);
    db.gameWatch.findMany.mockResolvedValue([
      { userId: 'user-7', game: { title: 'Catan' } },
      { userId: 'watcher-1', game: { title: 'Catan' } },
    ]);

    await listener.handle(makeExpansionCompleted());

    expect(notifications.createMany).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'user-7' }),
      expect.objectContaining({ userId: 'watcher-1' }),
    ]);
  });

  it('skips base-game imports', async () => {
    await listener.handle(makeExpansionCompleted({ isExpansion: false, baseGameId: undefined }));
    expect(db.gameWatch.findMany).not.toHaveBeenCalled();
  });

  it('skips re-imports (no new source)', async () => {
    await listener.handle(makeExpansionCompleted({ sourceCreated: false }));
    expect(db.gameWatch.findMany).not.toHaveBeenCalled();
  });

  it('skips an expansion missing its baseGameId', async () => {
    await listener.handle(makeExpansionCompleted({ baseGameId: undefined }));
    expect(db.gameWatch.findMany).not.toHaveBeenCalled();
  });

  it('does not create notifications when nobody watches the base game', async () => {
    await listener.handle(makeExpansionCompleted());
    expect(notifications.createMany).not.toHaveBeenCalled();
  });
});
