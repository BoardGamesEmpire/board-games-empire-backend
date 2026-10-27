import { NotificationType, SystemRole, type GameShareSnapshot } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { Logger } from '@nestjs/common';
import { GameShareNotificationListener } from './game-share-notification.listener';
import { GameShareCreatedEvent } from './game-share.events';

const NOW = new Date('2026-10-22T12:00:00Z');

const SHARE_ID = 'share-1';
const GAME_ID = 'game-1';
const HOUSEHOLD_ID = 'hh-1';
const SHARER_ID = 'user-riley';
const RECIPIENT_ID = 'user-sam';

/** Prisma's delegate types want full rows; the listener selects narrower ones. */
const resolves = (value: unknown) => value as never;

/** A share as the create's event carries it: in effect unless a test says it waits. */
const snapshot = (overrides: Partial<GameShareSnapshot> = {}): GameShareSnapshot => ({
  id: SHARE_ID,
  gameId: GAME_ID,
  userId: null,
  householdId: null,
  sharedById: SHARER_ID,
  approvedById: null,
  approvedAt: NOW,
  ...overrides,
});

const created = (overrides: Partial<GameShareSnapshot> = {}) => new GameShareCreatedEvent(snapshot(overrides), NOW);

/** Riley's share with Sam, which takes effect on create. */
const toUser = () => created({ userId: RECIPIENT_ID });

/** A household share in effect from the start, and one that waits for approval. */
const toHouseholdInEffect = () => created({ householdId: HOUSEHOLD_ID });
const toHouseholdWaiting = () => created({ householdId: HOUSEHOLD_ID, approvedAt: null });

/** What the listener reads of the stored share: the game, the sharer's name and the household. */
interface ShareRow {
  approvedAt: Date | null;
  game: { title: string; deletedAt: Date | null };
  sharedBy: { username: string; profile: { displayName: string | null } | null } | null;
  household: { name: string; deletedAt: Date | null } | null;
}

const RILEY = { username: 'riley', profile: { displayName: 'Riley' } };

const userShareRow = (overrides: Partial<ShareRow> = {}): ShareRow => ({
  approvedAt: NOW,
  game: { title: 'Carcassonne', deletedAt: null },
  sharedBy: RILEY,
  household: null,
  ...overrides,
});

const waitingRow = (overrides: Partial<ShareRow> = {}): ShareRow =>
  userShareRow({ approvedAt: null, household: { name: 'The Meeples', deletedAt: null }, ...overrides });

const RECEIVED = {
  userId: RECIPIENT_ID,
  type: NotificationType.GameShareReceived,
  payload: { shareId: SHARE_ID, gameId: GAME_ID, gameTitle: 'Carcassonne', sharerName: 'Riley' },
};

const AWAITING_PAYLOAD = {
  householdId: HOUSEHOLD_ID,
  householdName: 'The Meeples',
  shareId: SHARE_ID,
  gameId: GAME_ID,
  gameTitle: 'Carcassonne',
  sharerName: 'Riley',
};

describe('GameShareNotificationListener', () => {
  let listener: GameShareNotificationListener;
  let db: MockDatabaseService;
  let notifications: jest.Mocked<Pick<NotificationsService, 'create' | 'createMany'>>;
  let loggedError: jest.SpyInstance;
  let loggedDebug: jest.SpyInstance;

  beforeEach(async () => {
    notifications = {
      create: jest.fn().mockResolvedValue(undefined),
      createMany: jest.fn().mockResolvedValue(undefined),
    };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [GameShareNotificationListener, { provide: NotificationsService, useValue: notifications }],
    });

    listener = module.get(GameShareNotificationListener);
    db = mockDb;

    db.gameShare.findUnique.mockResolvedValue(resolves(userShareRow()));
    db.householdMember.findMany.mockResolvedValue([]);

    // The handler logs its own failure and resolves, so a test that expects
    // nothing sent would pass just as well if the handler threw before its
    // guard. An error logged therefore fails the test, unless the test made
    // the write fail on purpose and cleared it (#810).
    loggedError = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    loggedDebug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // Read before the restore, so a failure here still leaves the next test a real logger.
    const errorsLogged = [...loggedError.mock.calls];

    jest.restoreAllMocks();

    expect(errorsLogged).toEqual([]);
  });

  describe('a share to a user', () => {
    it('tells the user a game was shared with them, naming the game and who shared it (#810)', async () => {
      await listener.onShareCreated(toUser());

      // The stored share is read for what the event does not carry: the
      // game's title, the sharer's name and whether the share still stands.
      expect(db.gameShare.findUnique).toHaveBeenCalledWith({
        where: { id: SHARE_ID },
        select: {
          approvedAt: true,
          game: { select: { title: true, deletedAt: true } },
          sharedBy: { select: { username: true, profile: { select: { displayName: true } } } },
          household: { select: { name: true, deletedAt: true } },
        },
      });
      expect(notifications.create).toHaveBeenCalledTimes(1);
      expect(notifications.create).toHaveBeenCalledWith(RECEIVED);
      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it.each([
      ['no profile', null],
      ['no display name', { displayName: null }],
      ['a blank display name', { displayName: '' }],
    ])('names the sharer by their username when they have %s (#810)', async (_, profile) => {
      db.gameShare.findUnique.mockResolvedValue(resolves(userShareRow({ sharedBy: { username: 'riley', profile } })));

      await listener.onShareCreated(toUser());

      expect(notifications.create).toHaveBeenCalledWith({
        ...RECEIVED,
        payload: { ...RECEIVED.payload, sharerName: 'riley' },
      });
    });

    it.each([
      ['the share was removed', null],
      ['the game was deleted', userShareRow({ game: { title: 'Carcassonne', deletedAt: NOW } })],
      ['the sharer is no longer a user', userShareRow({ sharedBy: null })],
    ])('tells no one when %s before the handler ran (#810)', async (_, row) => {
      db.gameShare.findUnique.mockResolvedValue(resolves(row));

      await listener.onShareCreated(toUser());

      expect(notifications.create).not.toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
      expect(loggedDebug).toHaveBeenCalledWith(expect.stringContaining(`shareId=${SHARE_ID}`));
    });
  });

  describe('a household share', () => {
    it('tells the household owners and admins, but not the sharer, that a share awaits approval (#810)', async () => {
      db.gameShare.findUnique.mockResolvedValue(resolves(waitingRow()));
      db.householdMember.findMany.mockResolvedValue(
        resolves([{ userId: 'user-owner' }, { userId: 'user-admin' }, { userId: SHARER_ID }]),
      );

      await listener.onShareCreated(toHouseholdWaiting());

      expect(db.householdMember.findMany).toHaveBeenCalledWith({
        where: {
          householdId: HOUSEHOLD_ID,
          role: { role: { name: { in: [SystemRole.HouseholdOwner, SystemRole.HouseholdAdmin] } } },
        },
        select: { userId: true },
      });
      expect(notifications.createMany).toHaveBeenCalledTimes(1);
      expect(notifications.createMany).toHaveBeenCalledWith([
        { userId: 'user-owner', type: NotificationType.GameShareAwaitingApproval, payload: AWAITING_PAYLOAD },
        { userId: 'user-admin', type: NotificationType.GameShareAwaitingApproval, payload: AWAITING_PAYLOAD },
      ]);
      expect(notifications.create).not.toHaveBeenCalled();
    });

    it('tells no one of a household share that takes effect on create (#810)', async () => {
      db.householdMember.findMany.mockResolvedValue(resolves([{ userId: 'user-owner' }, { userId: 'user-admin' }]));

      await listener.onShareCreated(toHouseholdInEffect());

      // Nothing read at all: the event alone says the share needs no approval.
      expect(db.gameShare.findUnique).not.toHaveBeenCalled();
      expect(db.householdMember.findMany).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();

      // The control: the same household, the same roster and the same game
      // tell its owners and admins once the share waits.
      db.gameShare.findUnique.mockResolvedValue(resolves(waitingRow()));

      await listener.onShareCreated(toHouseholdWaiting());

      expect(notifications.createMany).toHaveBeenCalledTimes(1);
    });

    it('tells no one when the sharer is the only household owner or admin (#810)', async () => {
      db.gameShare.findUnique.mockResolvedValue(resolves(waitingRow()));
      db.householdMember.findMany.mockResolvedValue(resolves([{ userId: SHARER_ID }]));

      await listener.onShareCreated(toHouseholdWaiting());

      expect(db.householdMember.findMany).toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('tells no one when no household owner or admin remains (#810)', async () => {
      db.gameShare.findUnique.mockResolvedValue(resolves(waitingRow()));

      await listener.onShareCreated(toHouseholdWaiting());

      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it.each([
      ['the share was removed', null],
      ['the share was approved', waitingRow({ approvedAt: NOW })],
      ['the household was deleted', waitingRow({ household: { name: 'The Meeples', deletedAt: NOW } })],
      ['the household is gone', waitingRow({ household: null })],
      ['the game was deleted', waitingRow({ game: { title: 'Carcassonne', deletedAt: NOW } })],
      ['the sharer is no longer a user', waitingRow({ sharedBy: null })],
    ])('tells no one when %s before the handler ran (#810)', async (_, row) => {
      db.gameShare.findUnique.mockResolvedValue(resolves(row));
      db.householdMember.findMany.mockResolvedValue(resolves([{ userId: 'user-owner' }]));

      await listener.onShareCreated(toHouseholdWaiting());

      expect(notifications.createMany).not.toHaveBeenCalled();
      expect(loggedDebug).toHaveBeenCalledWith(expect.stringContaining(`shareId=${SHARE_ID}`));
    });
  });

  describe('every share', () => {
    it('tells no one of a share that names neither a user nor a household (#810)', async () => {
      await listener.onShareCreated(created());

      expect(db.gameShare.findUnique).not.toHaveBeenCalled();
      expect(notifications.create).not.toHaveBeenCalled();
      expect(notifications.createMany).not.toHaveBeenCalled();
    });

    it('logs and resolves when the write fails (#810)', async () => {
      const failure = new Error('DB down');
      notifications.create.mockRejectedValue(failure);
      notifications.createMany.mockRejectedValue(failure);
      db.householdMember.findMany.mockResolvedValue(resolves([{ userId: 'user-owner' }]));

      await expect(listener.onShareCreated(toUser())).resolves.toBeUndefined();

      db.gameShare.findUnique.mockResolvedValue(resolves(waitingRow()));
      await expect(listener.onShareCreated(toHouseholdWaiting())).resolves.toBeUndefined();

      expect(loggedError).toHaveBeenCalledTimes(2);
      expect(loggedError).toHaveBeenCalledWith(
        `Failed to notify on GameShareCreated shareId=${SHARE_ID}`,
        failure.stack,
      );
      // Logged on purpose, so cleared: the check after each test is for any other error.
      loggedError.mockClear();
    });

    it('logs and resolves when the read fails (#810)', async () => {
      const failure = new Error('DB down');
      db.gameShare.findUnique.mockRejectedValue(failure);

      await expect(listener.onShareCreated(toUser())).resolves.toBeUndefined();

      expect(notifications.create).not.toHaveBeenCalled();
      expect(loggedError).toHaveBeenCalledWith(
        `Failed to notify on GameShareCreated shareId=${SHARE_ID}`,
        failure.stack,
      );
      loggedError.mockClear();
    });
  });
});
