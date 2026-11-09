import type { Actor, AuditContextService } from '@bge/actor-context';
import { JobStatus, NotificationType, type DatabaseService } from '@bge/database';
import type { NotificationsService } from '@bge/notifications-service';
import { ImportJobCompletedEvent, type ImportJobCompletedContext } from '../events/import.events';
import { ImportJobOrigin } from '../interfaces/import-job.interface';
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
      origin: ImportJobOrigin.ChosenExpansion,
      gameTitle: 'Seafarers',
      thumbnail: null,
      gameCreated: true,
      sourceCreated: true,
      platformGames: [],
      baseGameIds: ['base-game-1'],
      isExpansion: true,
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
      { userId: 'user-7', gameId: 'base-game-1', game: { title: 'Catan' } },
      { userId: 'watcher-1', gameId: 'base-game-1', game: { title: 'Catan' } },
    ]);

    await listener.handle(makeExpansionCompleted());

    expect(db.gameWatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { gameId: { in: ['base-game-1'] } } }),
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
      { userId: 'user-7', gameId: 'base-game-1', game: { title: 'Catan' } },
      { userId: 'watcher-1', gameId: 'base-game-1', game: { title: 'Catan' } },
    ]);

    await listener.handle(makeExpansionCompleted());

    expect(notifications.createMany).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'user-7' }),
      expect.objectContaining({ userId: 'watcher-1' }),
    ]);
  });

  // #971: an expansion imported on its own was a requested game, and its
  // watchers heard nothing. It is an expansion by its links now, whatever
  // brought it into the batch.
  it('notifies watchers of an expansion imported on its own once it is linked', async () => {
    db.gameWatch.findMany.mockResolvedValue([{ userId: 'watcher-1', gameId: 'base-game-1', game: { title: 'Catan' } }]);

    await listener.handle(makeExpansionCompleted({ origin: ImportJobOrigin.Requested }));

    expect(notifications.createMany).toHaveBeenCalledWith([
      expect.objectContaining({ userId: 'watcher-1', payload: expect.objectContaining({ baseGameId: 'base-game-1' }) }),
    ]);
  });

  it('notifies each watcher once when the expansion is linked to several watched base games', async () => {
    db.gameWatch.findMany.mockResolvedValue([
      { userId: 'watcher-1', gameId: 'base-game-2', game: { title: "Tzolk'in: Tribes & Prophecies" } },
      { userId: 'watcher-1', gameId: 'base-game-1', game: { title: "Tzolk'in" } },
      { userId: 'watcher-2', gameId: 'base-game-2', game: { title: "Tzolk'in: Tribes & Prophecies" } },
    ]);

    await listener.handle(makeExpansionCompleted({ baseGameIds: ['base-game-1', 'base-game-2'] }));

    expect(db.gameWatch.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { gameId: { in: ['base-game-1', 'base-game-2'] } } }),
    );
    // A watcher of several of its base games hears of it once, under the
    // first one its DataGateway named.
    expect(notifications.createMany).toHaveBeenCalledWith([
      expect.objectContaining({
        userId: 'watcher-1',
        payload: expect.objectContaining({ baseGameId: 'base-game-1', baseGameTitle: "Tzolk'in" }),
      }),
      expect.objectContaining({
        userId: 'watcher-2',
        payload: expect.objectContaining({ baseGameId: 'base-game-2', baseGameTitle: "Tzolk'in: Tribes & Prophecies" }),
      }),
    ]);
  });

  it('skips a game that is not an expansion, a remaster linked to its original say (#971)', async () => {
    await listener.handle(makeExpansionCompleted({ isExpansion: false }));
    expect(db.gameWatch.findMany).not.toHaveBeenCalled();
  });

  it('skips an expansion whose base game its batch is adding, which nobody can watch yet (#971)', async () => {
    await listener.handle(makeExpansionCompleted({ baseGameIds: [] }));
    expect(db.gameWatch.findMany).not.toHaveBeenCalled();
  });

  it('skips re-imports (no new source)', async () => {
    await listener.handle(makeExpansionCompleted({ sourceCreated: false }));
    expect(db.gameWatch.findMany).not.toHaveBeenCalled();
  });

  it('does not create notifications when nobody watches the base game', async () => {
    await listener.handle(makeExpansionCompleted());
    expect(notifications.createMany).not.toHaveBeenCalled();
  });
});
