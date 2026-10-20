import { NotificationType } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { Logger } from '@nestjs/common';
import { GatewayDisabledEvent, type GatewayAutoDisableFailure } from '../events/gateway-registry.events';
import { GatewayNotificationListener } from './gateway-notification.listener';

const failure: GatewayAutoDisableFailure = {
  reason: 'repeated_connection_failure',
  consecutiveFailures: 3,
  firstFailureAt: new Date('2026-10-19T10:00:00.000Z'),
  lastFailureAt: new Date('2026-10-19T10:04:00.000Z'),
  lastError: 'connect ECONNREFUSED 10.0.0.5:50051',
};

const disabledEvent = (lastError = failure.lastError) =>
  new GatewayDisabledEvent(
    { id: 'bgg', enabled: true },
    { id: 'bgg', enabled: false },
    { ...failure, lastError },
    new Date(),
  );

describe('GatewayNotificationListener', () => {
  let listener: GatewayNotificationListener;
  let db: MockDatabaseService;
  let notifications: jest.Mocked<Pick<NotificationsService, 'createMany'>>;

  beforeEach(async () => {
    notifications = { createMany: jest.fn().mockResolvedValue(undefined) };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [GatewayNotificationListener, { provide: NotificationsService, useValue: notifications }],
    });

    listener = module.get(GatewayNotificationListener);
    db = mockDb;

    db.user.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }] as never);
    db.dataGateway.findFirst.mockResolvedValue({ name: 'BoardGameGeek', disabledCapabilities: [] } as never);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('onGatewayDisabled', () => {
    it('tells every server admin that a DataGateway was auto-disabled, with the reason and the failure details (#763)', async () => {
      await listener.onGatewayDisabled(disabledEvent());

      expect(db.dataGateway.findFirst).toHaveBeenCalledWith({
        where: { id: 'bgg', deletedAt: null },
        select: { name: true, disabledCapabilities: true },
      });

      const payload = {
        gatewayId: 'bgg',
        gatewayName: 'BoardGameGeek',
        reason: 'repeated_connection_failure',
        consecutiveFailures: 3,
        firstFailureAt: '2026-10-19T10:00:00.000Z',
        lastFailureAt: '2026-10-19T10:04:00.000Z',
        lastError: 'connect ECONNREFUSED 10.0.0.5:50051',
      };
      expect(notifications.createMany).toHaveBeenCalledWith([
        { userId: 'admin-1', type: NotificationType.DataGatewayAutoDisabled, payload },
        { userId: 'admin-2', type: NotificationType.DataGatewayAutoDisabled, payload },
      ]);
    });

    it('keeps the first 1,000 characters of a long lastError and marks the cut (#763)', async () => {
      await listener.onGatewayDisabled(disabledEvent(`<html>${'x'.repeat(2_000)}</html>`));

      const payload = expect.objectContaining({ lastError: `<html>${'x'.repeat(994)}…` });
      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({ payload }),
        expect.objectContaining({ payload }),
      ]);
    });

    it('cuts a long lastError between characters, never through an emoji, which PostgreSQL would refuse (#763)', async () => {
      await listener.onGatewayDisabled(disabledEvent(`${'x'.repeat(999)}😀 and the rest`));

      const payload = expect.objectContaining({ lastError: `${'x'.repeat(999)}😀…` });
      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({ payload }),
        expect.objectContaining({ payload }),
      ]);
    });

    it('replaces a NUL in lastError with U+FFFD, since PostgreSQL refuses one in JSON (#763)', async () => {
      await listener.onGatewayDisabled(disabledEvent('unexpected \u0000 in reply'));

      const payload = expect.objectContaining({ lastError: 'unexpected \uFFFD in reply' });
      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({ payload }),
        expect.objectContaining({ payload }),
      ]);
    });

    it('replaces half a surrogate pair in lastError with U+FFFD, since PostgreSQL refuses one in JSON, and keeps whole pairs (#763)', async () => {
      await listener.onGatewayDisabled(disabledEvent('cut \uD83D here, \uDE00 there, 😀 kept'));

      const payload = expect.objectContaining({ lastError: 'cut \uFFFD here, \uFFFD there, 😀 kept' });
      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({ payload }),
        expect.objectContaining({ payload }),
      ]);
    });

    it("runs no repeat check: auto-disable can't fire again until a server admin enables the DataGateway (#763)", async () => {
      await listener.onGatewayDisabled(disabledEvent());

      expect(db.notification.findFirst).not.toHaveBeenCalled();
      expect(db.notification.findMany).not.toHaveBeenCalled();
      expect(notifications.createMany).toHaveBeenCalledTimes(1);
    });

    it('tells no one about a DataGateway deleted before the handler ran (#763)', async () => {
      db.dataGateway.findFirst.mockResolvedValue(null);

      await listener.onGatewayDisabled(disabledEvent());

      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('warns and sends nothing when the server has no server admins yet (#763)', async () => {
      db.user.findMany.mockResolvedValue([]);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await listener.onGatewayDisabled(disabledEvent());

      expect(warn).toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('logs and resolves when the write fails (#763)', async () => {
      notifications.createMany.mockRejectedValue(new Error('db down'));
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(listener.onGatewayDisabled(disabledEvent())).resolves.toBeUndefined();

      expect(error).toHaveBeenCalled();
    });
  });
});
