import { NotificationType } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { Logger } from '@nestjs/common';
import { UserCreatedEvent } from '../events/auth.events';
import { UsernameVariantNotificationListener } from './username-variant-notification.listener';

const NOW = new Date('2026-10-28T12:00:00Z');

const created = (requestedUsername: string | null) =>
  new UserCreatedEvent(
    { id: 'user-1', username: 'jason-2', email: 'jason@example.com', isAnonymous: false },
    NOW,
    requestedUsername,
  );

describe('UsernameVariantNotificationListener', () => {
  let listener: UsernameVariantNotificationListener;
  let db: MockDatabaseService;
  let notifications: jest.Mocked<Pick<NotificationsService, 'create'>>;
  let loggedError: jest.SpyInstance;

  const settingAllows = (allowUsernameChange: boolean) =>
    db.systemSetting.findUnique.mockResolvedValue({ allowUsernameChange } as never);

  beforeEach(async () => {
    notifications = { create: jest.fn().mockResolvedValue(undefined) };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [UsernameVariantNotificationListener, { provide: NotificationsService, useValue: notifications }],
    });

    listener = module.get(UsernameVariantNotificationListener);
    db = mockDb;
    settingAllows(true);
    loggedError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('tells the user the username they got, the one that was taken, and whether they can change it (#912)', async () => {
    await listener.handle(created('jason'));

    expect(db.systemSetting.findUnique).toHaveBeenCalledWith({
      where: { singleton: true },
      select: { allowUsernameChange: true },
    });
    expect(notifications.create).toHaveBeenCalledWith({
      userId: 'user-1',
      type: NotificationType.UsernameVariantAssigned,
      payload: { username: 'jason-2', requestedUsername: 'jason', usernameChangeAllowed: true },
    });
  });

  it('says the username can’t be changed while changes are off (#912)', async () => {
    settingAllows(false);

    await listener.handle(created('jason'));

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ usernameChangeAllowed: false }) }),
    );
  });

  // The username-change gate refuses a change when the row is missing, so the
  // notification must not offer one then either.
  it('says the username can’t be changed when there is no settings row (#912)', async () => {
    db.systemSetting.findUnique.mockResolvedValue(null);

    await listener.handle(created('jason'));

    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ usernameChangeAllowed: false }) }),
    );
  });

  it('sends nothing when the user kept the username they asked for (#912)', async () => {
    await listener.handle(created(null));

    expect(notifications.create).not.toHaveBeenCalled();
    expect(db.systemSetting.findUnique).not.toHaveBeenCalled();
  });

  it('logs and resolves when the write fails, so the user stays created (#912)', async () => {
    notifications.create.mockRejectedValue(new Error('db down'));

    await expect(listener.handle(created('jason'))).resolves.toBeUndefined();
    expect(loggedError).toHaveBeenCalledWith(expect.stringContaining('user-1'), expect.any(String));
  });
});
