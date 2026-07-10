import type { Actor, AuditContextService } from '@bge/actor-context';
import { JobStatus, type DatabaseService } from '@bge/database';
import { ImportJobCompletedEvent, type ImportJobCompletedContext } from '../events/import.events';
import { ImportActivityListener } from './import-activity.listener';

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
      thumbnail: 'http://x/y.png',
      gameCreated: true,
      sourceCreated: true,
      platformGames: [],
      ...ctx,
    },
    new Date(),
  );

describe('ImportActivityListener', () => {
  let listener: ImportActivityListener;
  let db: { importActivity: { create: jest.Mock } };
  let auditContext: { getActor: jest.Mock };

  beforeEach(() => {
    db = { importActivity: { create: jest.fn().mockResolvedValue(undefined) } };
    auditContext = { getActor: jest.fn().mockReturnValue(USER_ACTOR) };
    listener = new ImportActivityListener(
      db as unknown as DatabaseService,
      auditContext as unknown as AuditContextService,
    );
  });

  afterEach(() => jest.clearAllMocks());

  it('records the activity attributed to the CLS user actor', async () => {
    await listener.handle(makeCompleted());

    expect(db.importActivity.create).toHaveBeenCalledWith({
      data: {
        gameId: 'game-1',
        importedById: 'user-7',
        gatewayId: 'bgg',
        isExpansion: false,
        gameTitle: 'Catan',
        thumbnail: 'http://x/y.png',
      },
    });
  });

  it('records a null importedById for system-initiated imports', async () => {
    auditContext.getActor.mockReturnValue(SYSTEM_ACTOR);

    await listener.handle(makeCompleted());

    expect(db.importActivity.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ importedById: null }) }),
    );
  });

  it('skips re-imports (no new source)', async () => {
    await listener.handle(makeCompleted({ sourceCreated: false }));
    expect(db.importActivity.create).not.toHaveBeenCalled();
  });

  it('never throws into the emitter when the write fails', async () => {
    db.importActivity.create.mockRejectedValue(new Error('db down'));
    await expect(listener.handle(makeCompleted())).resolves.toBeUndefined();
  });
});
