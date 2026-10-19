import { InviteStatus, InviteType, NotificationType, SystemRole } from '@bge/database';
import { InviteApprovedEvent, InviteCreatedEvent, type InviteSnapshot } from '@bge/invites';
import { NotificationsService } from '@bge/notifications-service';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { Logger } from '@nestjs/common';
import { receivedHouseholdInviteWhere } from '../invite/received-invites';
import { HouseholdNotificationListener } from './household-notification.listener';

const NOW = new Date('2026-10-18T12:00:00Z');
const LATER = new Date('2026-10-25T12:00:00Z');

const HOUSEHOLD_ID = 'hh-1';
const INVITER_ID = 'user-riley';
const INVITEE_ID = 'user-sam';
const ADDRESS = 'sam@example.com';

/** Prisma's delegate types want full rows; the listener selects narrower ones. */
const resolves = (value: unknown) => value as never;

/** A household invite to Sam by id, from Riley, as the lib's events carry it. */
const snapshot = (overrides: Partial<InviteSnapshot> = {}): InviteSnapshot => ({
  id: 'invite-1',
  type: InviteType.Household,
  status: InviteStatus.Pending,
  inviterId: INVITER_ID,
  inviteeId: INVITEE_ID,
  inviteeName: 'Sam',
  inviteeEmail: null,
  householdId: HOUSEHOLD_ID,
  eventId: null,
  roleId: 'role-member',
  expiresAt: LATER,
  respondedAt: null,
  ...overrides,
});

/** The same invite sent to Sam's address: it names no user until accepted. */
const BY_ADDRESS: Partial<InviteSnapshot> = { inviteeId: null, inviteeEmail: ADDRESS };

const created = (overrides: Partial<InviteSnapshot> = {}) => new InviteCreatedEvent(snapshot(overrides), NOW);

const approved = (overrides: Partial<InviteSnapshot> = {}) =>
  new InviteApprovedEvent(
    snapshot({ status: InviteStatus.AwaitingApproval, ...overrides }),
    snapshot({ status: InviteStatus.Pending, ...overrides }),
    NOW,
  );

interface UserRow {
  id: string;
  email: string;
  emailVerified: boolean;
  username: string;
  profile: { displayName: string | null } | null;
}

const RILEY: UserRow = {
  id: INVITER_ID,
  email: 'riley@example.com',
  emailVerified: true,
  username: 'riley',
  profile: { displayName: 'Riley' },
};

const SAM: UserRow = { id: INVITEE_ID, email: ADDRESS, emailVerified: true, username: 'sam', profile: null };

/**
 * What Sam is told of the invite, however it reached them: the household, the
 * invite and who sent it. Never an address, by id or by address: they know
 * their own.
 */
const RECEIVED = {
  userId: INVITEE_ID,
  type: NotificationType.HouseholdInviteReceived,
  payload: { householdId: HOUSEHOLD_ID, householdName: 'The Meeples', inviteId: 'invite-1', inviterName: 'Riley' },
};

describe('HouseholdNotificationListener', () => {
  let listener: HouseholdNotificationListener;
  let db: MockDatabaseService;
  let notifications: jest.Mocked<Pick<NotificationsService, 'create' | 'createMany'>>;
  let loggedError: jest.SpyInstance;

  /**
   * Answers `user.findUnique` by id or by address from these rows. Each
   * carries every column the listener's three user reads select: the id, the
   * vouched address and the display name.
   */
  const seedUsers = (...rows: UserRow[]) =>
    db.user.findUnique.mockImplementation((({ where }: { where: { id?: string; email?: string } }) =>
      Promise.resolve(rows.find((row) => row.id === where.id || row.email === where.email) ?? null)) as never);

  beforeEach(async () => {
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      createMany: jest.fn().mockResolvedValue(undefined),
    };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [HouseholdNotificationListener, { provide: NotificationsService, useValue: notifications }],
    });

    listener = module.get(HouseholdNotificationListener);
    db = mockDb;

    db.household.findUnique.mockResolvedValue(resolves({ name: 'The Meeples', deletedAt: null }));
    db.householdMember.findMany.mockResolvedValue([]);
    db.invite.count.mockResolvedValue(1);
    seedUsers(RILEY, SAM);

    // Every handler logs its own failure and resolves, so a test that expects
    // nothing sent would pass just as well if the handler threw before its
    // guard. An error logged therefore fails the test, unless the test made
    // the write fail on purpose and cleared it (#167).
    loggedError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Read before the restore, so a failure here still leaves the next test
    // real timers and a real logger.
    const errorsLogged = [...loggedError.mock.calls];

    jest.useRealTimers();
    jest.restoreAllMocks();

    expect(errorsLogged).toEqual([]);
  });

  describe('the invitee', () => {
    it('notifies an invitee named by id when the invite opens Pending (#167)', async () => {
      jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });

      await listener.onInviteCreated(created());

      // The inbox's own predicate, asked about this one invite: the invitee
      // is told exactly when their inbox would list it.
      expect(db.invite.count).toHaveBeenCalledWith({
        where: { id: 'invite-1', AND: [receivedHouseholdInviteWhere(INVITEE_ID, ADDRESS, NOW)] },
      });
      // An invite by id names its user; no address is looked up.
      expect(db.user.findUnique).not.toHaveBeenCalledWith({
        where: { email: expect.anything() },
        select: { id: true },
      });
      expect(notifications.create).toHaveBeenCalledWith(RECEIVED);
    });

    it.each([
      ['no profile', null],
      ['no display name', { displayName: null }],
      ['a blank display name', { displayName: '' }],
    ])('names the inviter by their username when they have %s (#167)', async (_, profile) => {
      seedUsers({ ...RILEY, profile }, SAM);

      await listener.onInviteCreated(created());

      expect(notifications.create).toHaveBeenCalledWith({
        ...RECEIVED,
        payload: { ...RECEIVED.payload, inviterName: 'riley' },
      });
    });

    it('notifies the verified user holding the address, when their inbox would list the invite (#167)', async () => {
      await listener.onInviteCreated(created(BY_ADDRESS));

      // Matched exactly, as the invitee gate matches it: better-auth
      // lower-cases every address it writes.
      expect(db.user.findUnique).toHaveBeenCalledWith({ where: { email: ADDRESS }, select: { id: true } });
      expect(db.user.findUnique).toHaveBeenCalledWith({
        where: { id: INVITEE_ID },
        select: { email: true, emailVerified: true },
      });
      expect(notifications.create).toHaveBeenCalledWith(RECEIVED);
    });

    it('notifies no one when the user holding the address is unverified, already a member, or the inviter (#167)', async () => {
      // The inbox's predicate is what refuses each of these, and the e2e
      // drives it against a real database (#167). Here it counts nothing, as
      // it would for any of them.
      seedUsers(RILEY, { ...SAM, emailVerified: false });
      db.invite.count.mockResolvedValue(0);

      await listener.onInviteCreated(created(BY_ADDRESS));

      expect(db.invite.count).toHaveBeenCalledTimes(1);
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('tells the invitee nothing while the invite awaits approval, and tells them on approval (#167, #166)', async () => {
      await listener.onInviteCreated(created({ status: InviteStatus.AwaitingApproval }));

      // Their inbox does not list it yet, so it is not asked.
      expect(db.invite.count).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();

      await listener.onInviteApproved(approved());

      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(RECEIVED);
    });
  });

  describe('the approvers', () => {
    it('tells household owners and admins, but not the inviter, that an invite awaits their approval, with the name and address (#167)', async () => {
      db.householdMember.findMany.mockResolvedValue(
        resolves([{ userId: 'user-owner' }, { userId: 'user-admin' }, { userId: INVITER_ID }]),
      );

      await listener.onInviteCreated(created({ ...BY_ADDRESS, status: InviteStatus.AwaitingApproval }));

      expect(db.householdMember.findMany).toHaveBeenCalledWith({
        where: {
          householdId: HOUSEHOLD_ID,
          role: { role: { name: { in: [SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin] } } },
        },
        select: { userId: true },
      });

      // Sent by address, so no user is named: the name and the address
      // are as the inviter gave them.
      const payload = {
        householdId: HOUSEHOLD_ID,
        householdName: 'The Meeples',
        inviteId: 'invite-1',
        inviterName: 'Riley',
        inviteeId: null,
        inviteeName: 'Sam',
        inviteeEmail: ADDRESS,
      };
      expect(notifications.createMany).toHaveBeenCalledWith([
        { userId: 'user-owner', type: NotificationType.HouseholdInviteAwaitingApproval, payload },
        { userId: 'user-admin', type: NotificationType.HouseholdInviteAwaitingApproval, payload },
      ]);
    });
  });

  describe('every handler', () => {
    it('ignores an event invite (#742)', async () => {
      // A household id as well, so the type alone tells it apart.
      const eventInvite = { type: InviteType.Event, householdId: HOUSEHOLD_ID, eventId: 'ev-1' };

      await listener.onInviteCreated(created(eventInvite));
      await listener.onInviteCreated(created({ ...eventInvite, status: InviteStatus.AwaitingApproval }));
      await listener.onInviteApproved(approved(eventInvite));

      expect(db.household.findUnique).not.toHaveBeenCalled();
      expect(db.householdMember.findMany).not.toHaveBeenCalled();
      expect(db.user.findUnique).not.toHaveBeenCalled();
      expect(db.invite.count).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('sends nothing for a household deleted before the handler ran (#167)', async () => {
      jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      db.household.findUnique.mockResolvedValue(resolves({ name: 'The Meeples', deletedAt: NOW }));
      db.householdMember.findMany.mockResolvedValue(resolves([{ userId: 'user-owner' }]));

      await listener.onInviteCreated(created());
      await listener.onInviteCreated(created({ status: InviteStatus.AwaitingApproval }));
      await listener.onInviteApproved(approved());

      expect(db.household.findUnique).toHaveBeenCalledWith({
        where: { id: HOUSEHOLD_ID },
        select: { name: true, deletedAt: true },
      });
      expect(notifications.create).not.toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('logs and resolves when the write fails (#167)', async () => {
      const failure = new Error('DB down');
      notifications.create.mockRejectedValue(failure);

      await expect(listener.onInviteCreated(created())).resolves.toBeUndefined();
      await expect(listener.onInviteApproved(approved())).resolves.toBeUndefined();

      expect(loggedError).toHaveBeenCalledWith('Failed to notify on InviteCreated inviteId=invite-1', failure.stack);
      expect(loggedError).toHaveBeenCalledWith('Failed to notify on InviteApproved inviteId=invite-1', failure.stack);
      // Logged on purpose, so cleared: the check after each test is for any other error.
      loggedError.mockClear();
    });
  });
});
