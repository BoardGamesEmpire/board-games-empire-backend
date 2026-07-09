import { NotificationType } from '@bge/database';
import type { NotificationsService } from '@bge/notifications-service';
import { createMockDatabaseService, type MockDatabaseService } from '@bge/testing';
import { Logger } from '@nestjs/common';
import { AuditUnattributedNotifierService } from './audit-unattributed-notifier.service';

describe('AuditUnattributedNotifierService', () => {
  let db: MockDatabaseService;
  let notifications: jest.Mocked<Pick<NotificationsService, 'createMany'>>;
  let service: AuditUnattributedNotifierService;

  beforeEach(() => {
    db = createMockDatabaseService();
    db.notification.findFirst.mockResolvedValue(null);
    db.user.findMany.mockResolvedValue([{ id: 'admin-1' }, { id: 'admin-2' }] as never);
    notifications = { createMany: jest.fn().mockResolvedValue(undefined) };
    service = new AuditUnattributedNotifierService(db as never, notifications as unknown as NotificationsService);
  });

  it('notifies every Owner/Admin user with the event payload', async () => {
    await service.notify('sample.created', 'Sample', 'queue');

    expect(db.user.findMany).toHaveBeenCalledWith({
      where: { roles: { some: { role: { name: { in: ['Owner', 'Admin'] } } } } },
      select: { id: true },
    });
    expect(notifications.createMany).toHaveBeenCalledWith([
      {
        userId: 'admin-1',
        type: NotificationType.AuditUnattributedEvent,
        payload: { eventName: 'sample.created', subject: 'Sample', source: 'queue' },
      },
      {
        userId: 'admin-2',
        type: NotificationType.AuditUnattributedEvent,
        payload: { eventName: 'sample.created', subject: 'Sample', source: 'queue' },
      },
    ]);
  });

  it('dedupes repeat occurrences through the DB unread check, not an in-process memo', async () => {
    // First occurrence creates; while its notification is unread, repeats are suppressed.
    db.notification.findFirst.mockResolvedValueOnce(null).mockResolvedValue({ id: 'n1' } as never);

    await service.notify('sample.created', 'Sample', null);
    await service.notify('sample.created', 'Sample', null);

    expect(db.notification.findFirst).toHaveBeenCalledTimes(2);
    expect(notifications.createMany).toHaveBeenCalledTimes(1);
  });

  it('raises a fresh notification once admins mark the previous one read', async () => {
    // findFirst finds no UNREAD notification either time (the first was read).
    await service.notify('sample.created', 'Sample', null);
    await service.notify('sample.created', 'Sample', null);

    expect(notifications.createMany).toHaveBeenCalledTimes(2);
  });

  it('does not permanently suppress an event after a transient DB failure', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db.user.findMany.mockRejectedValueOnce(new Error('transient'));

    await service.notify('sample.created', 'Sample', null);
    expect(notifications.createMany).not.toHaveBeenCalled();

    await service.notify('sample.created', 'Sample', null);
    expect(notifications.createMany).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('treats distinct event names as distinct notifications', async () => {
    await service.notify('sample.created', 'Sample', null);
    await service.notify('sample.deleted', 'Sample', null);

    expect(notifications.createMany).toHaveBeenCalledTimes(2);
  });

  it('suppresses re-raising while an unread notification for the event exists', async () => {
    db.notification.findFirst.mockResolvedValue({ id: 'n1' } as never);

    await service.notify('sample.created', 'Sample', null);

    // Scoped to the admin ids so the query can use the (userId, read,
    // createdAt) index instead of scanning on the JSON payload match.
    expect(db.notification.findFirst).toHaveBeenCalledWith({
      where: {
        userId: { in: ['admin-1', 'admin-2'] },
        read: false,
        type: NotificationType.AuditUnattributedEvent,
        payload: { path: ['eventName'], equals: 'sample.created' },
      },
      select: { id: true },
    });
    expect(notifications.createMany).not.toHaveBeenCalled();
  });

  it('warns and skips when no admin users exist', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    db.user.findMany.mockResolvedValue([] as never);

    await service.notify('sample.created', 'Sample', null);

    expect(db.notification.findFirst).not.toHaveBeenCalled();
    expect(notifications.createMany).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No admin users'));
    warnSpy.mockRestore();
  });

  it('swallows lookup/creation failures', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    db.notification.findFirst.mockRejectedValue(new Error('db down'));

    await expect(service.notify('sample.created', 'Sample', null)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('db down'));
    errorSpy.mockRestore();
  });
});
