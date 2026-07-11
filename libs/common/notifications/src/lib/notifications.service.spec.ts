import { JobType, NotificationType } from '@bge/database';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let db: MockDatabaseService;

  beforeEach(async () => {
    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [NotificationsService],
    });

    service = module.get(NotificationsService);
    db = mockDb;
  });

  afterEach(() => jest.clearAllMocks());

  it('should be defined', () => {
    expect(service).toBeTruthy();
  });

  it('persists a typed create with its type-specific payload', async () => {
    db.notification.create.mockResolvedValue({} as never);

    // Payload is checked against GameImportedPayload — a foreign field here
    // (e.g. `eventId`) would fail to compile.
    await service.create({
      userId: 'user-1',
      type: NotificationType.GameImported,
      payload: { gameId: 'g-1', gameTitle: 'Catan', thumbnail: null, jobId: 'j-1', batchId: 'b-1' },
    });

    expect(db.notification.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: 'user-1',
        type: NotificationType.GameImported,
        payload: expect.objectContaining({ gameId: 'g-1', gameTitle: 'Catan' }),
      }),
    });
  });

  it('persists a batch of typed creates', async () => {
    db.notification.createMany.mockResolvedValue({ count: 1 } as never);

    await service.createMany([
      {
        userId: 'user-1',
        type: NotificationType.ImportFailed,
        payload: {
          jobType: JobType.GameImport,
          jobId: 'j-1',
          batchId: 'b-1',
          gatewayId: 'gw-1',
          externalId: 'x-1',
          isExpansion: false,
          errorCode: 'GATEWAY_UNAVAILABLE',
          error: 'The gateway is temporarily unavailable.',
        },
      },
    ]);

    expect(db.notification.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ userId: 'user-1', type: NotificationType.ImportFailed })],
      }),
    );
  });

  it('caps getUnread to the most-recent 100 unread rows', async () => {
    db.notification.findMany.mockResolvedValue([]);

    await service.getUnread('user-1');

    expect(db.notification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: 'user-1', read: false },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    );
  });
});
