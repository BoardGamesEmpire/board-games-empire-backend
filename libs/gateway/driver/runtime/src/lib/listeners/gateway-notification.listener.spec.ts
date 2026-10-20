import { DataGatewayCapability, NotificationType } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { Logger } from '@nestjs/common';
import {
  GatewayCapabilitiesChangedEvent,
  GatewayDisabledEvent,
  type GatewayAutoDisableFailure,
} from '../events/gateway-registry.events';
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

const { Search, Fetch, FetchExpansions, ListLanguages } = DataGatewayCapability;

const changedEvent = (before: DataGatewayCapability[], after: DataGatewayCapability[]) =>
  new GatewayCapabilitiesChangedEvent(
    { id: 'bgg', capabilities: before },
    { id: 'bgg', capabilities: after },
    new Date(),
  );

/**
 * The repeat check for a loss of `lost`: which server admins already hold an
 * unread notification for the DataGateway naming every one of them, among
 * any others (#763).
 */
const repeatCheck = (lost: DataGatewayCapability[]) => ({
  where: {
    userId: { in: ['admin-1', 'admin-2'] },
    read: false,
    type: NotificationType.DataGatewayCapabilitiesLost,
    AND: [
      { payload: { path: ['gatewayId'], equals: 'bgg' } },
      { payload: { path: ['lostCapabilities'], array_contains: lost } },
    ],
  },
  select: { userId: true },
});

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
    db.notification.findMany.mockResolvedValue([]);
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

  describe('onCapabilitiesChanged', () => {
    it('tells every server admin which capabilities a DataGateway lost at an interview (#763)', async () => {
      await listener.onCapabilitiesChanged(changedEvent([Search, Fetch, FetchExpansions], [Fetch]));

      const payload = { gatewayId: 'bgg', gatewayName: 'BoardGameGeek', lostCapabilities: [Search, FetchExpansions] };
      expect(notifications.createMany).toHaveBeenCalledWith([
        { userId: 'admin-1', type: NotificationType.DataGatewayCapabilitiesLost, payload },
        { userId: 'admin-2', type: NotificationType.DataGatewayCapabilitiesLost, payload },
      ]);
    });

    it('tells no one about a gained capability or a first interview, and reads nothing (#763, #709)', async () => {
      await listener.onCapabilitiesChanged(changedEvent([], [Search]));
      await listener.onCapabilitiesChanged(changedEvent([Fetch], [Fetch, Search]));

      expect(db.dataGateway.findFirst).not.toHaveBeenCalled();
      expect(db.user.findMany).not.toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('leaves out a capability a server admin switched off (#763, #715)', async () => {
      db.dataGateway.findFirst.mockResolvedValue({ name: 'BoardGameGeek', disabledCapabilities: [Search] } as never);

      await listener.onCapabilitiesChanged(changedEvent([Search, FetchExpansions], []));

      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({ payload: expect.objectContaining({ lostCapabilities: [FetchExpansions] }) }),
        expect.objectContaining({ payload: expect.objectContaining({ lostCapabilities: [FetchExpansions] }) }),
      ]);
    });

    it('tells no one when only switched-off capabilities are gone, and runs no repeat check (#763, #715)', async () => {
      db.dataGateway.findFirst.mockResolvedValue({ name: 'BoardGameGeek', disabledCapabilities: [Search] } as never);

      await listener.onCapabilitiesChanged(changedEvent([Search, Fetch], [Fetch]));

      expect(db.notification.findMany).not.toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('skips a repeat for every server admin whose unread notification already names the capabilities lost now (#763)', async () => {
      db.notification.findMany.mockResolvedValue([{ userId: 'admin-1' }, { userId: 'admin-2' }] as never);

      await listener.onCapabilitiesChanged(changedEvent([Search, Fetch, FetchExpansions], [Fetch]));

      expect(db.notification.findMany).toHaveBeenCalledWith(repeatCheck([Search, FetchExpansions]));
      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('skips a server admin whose unread notification names the capabilities lost now among others, as after a switch-off (#763)', async () => {
      db.dataGateway.findFirst.mockResolvedValue({ name: 'BoardGameGeek', disabledCapabilities: [Search] } as never);
      db.notification.findMany.mockResolvedValue([{ userId: 'admin-1' }] as never);

      await listener.onCapabilitiesChanged(changedEvent([Search, FetchExpansions], []));

      expect(db.notification.findMany).toHaveBeenCalledWith(repeatCheck([FetchExpansions]));
      expect(notifications.createMany).toHaveBeenCalledWith([expect.objectContaining({ userId: 'admin-2' })]);
    });

    it("tells a server admin who read theirs, though another server admin's copy is still unread (#763)", async () => {
      db.notification.findMany.mockResolvedValue([{ userId: 'admin-2' }] as never);

      await listener.onCapabilitiesChanged(changedEvent([Search, Fetch], [Fetch]));

      expect(notifications.createMany).toHaveBeenCalledWith([
        {
          userId: 'admin-1',
          type: NotificationType.DataGatewayCapabilitiesLost,
          payload: { gatewayId: 'bgg', gatewayName: 'BoardGameGeek', lostCapabilities: [Search] },
        },
      ]);
    });

    it('lists the lost capabilities in the stored order, however the interview lists what remains (#763)', async () => {
      await listener.onCapabilitiesChanged(changedEvent([Search, Fetch, FetchExpansions], [ListLanguages, Fetch]));

      expect(notifications.createMany).toHaveBeenCalledWith([
        expect.objectContaining({ payload: expect.objectContaining({ lostCapabilities: [Search, FetchExpansions] }) }),
        expect.objectContaining({ payload: expect.objectContaining({ lostCapabilities: [Search, FetchExpansions] }) }),
      ]);
    });

    it('tells the server admins again once the earlier notifications were read (#763)', async () => {
      db.notification.findMany.mockResolvedValue([]);

      await listener.onCapabilitiesChanged(changedEvent([Search, Fetch], [Fetch]));

      expect(db.notification.findMany).toHaveBeenCalledWith(repeatCheck([Search]));
      expect(notifications.createMany).toHaveBeenCalledTimes(1);
    });

    it('tells no one about a DataGateway deleted before the handler ran (#763)', async () => {
      db.dataGateway.findFirst.mockResolvedValue(null);

      await listener.onCapabilitiesChanged(changedEvent([Search, Fetch], [Fetch]));

      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('warns and sends nothing when the server has no server admins yet (#763)', async () => {
      db.user.findMany.mockResolvedValue([]);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

      await listener.onCapabilitiesChanged(changedEvent([Search, Fetch], [Fetch]));

      expect(warn).toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('logs and resolves when the repeat check fails (#763)', async () => {
      db.notification.findMany.mockRejectedValue(new Error('db down'));
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(listener.onCapabilitiesChanged(changedEvent([Search, Fetch], [Fetch]))).resolves.toBeUndefined();

      expect(error).toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
    });
  });
});
