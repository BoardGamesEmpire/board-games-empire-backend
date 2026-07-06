import type { GameCollection, GameRelease, PlatformGame } from '@bge/database';
import { Action, GameMedium, GameRemovalReason, Prisma, ResourceType, Visibility } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { createTestingModuleWithDb, type MockDatabaseService } from '@bge/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GameCollectionService } from './game-collection.service';

const dependentRecordNotFound = () =>
  new Prisma.PrismaClientKnownRequestError('Dependent record not found', { code: 'P2025', clientVersion: 'test' });

const COND = { id: 'sentinel-condition' };
const ME = 'user-1';

const entry = (overrides: Partial<GameCollection> = {}): GameCollection =>
  ({
    id: 'gc-1',
    userId: ME,
    platformGameId: 'pg-1',
    releaseId: null,
    medium: GameMedium.Physical,
    quantity: 1,
    visibility: Visibility.Private,
    rating: null,
    playCount: 3,
    playAgain: true,
    favorite: true,
    comment: null,
    lastPlayed: new Date('2026-01-01'),
    lastUpdated: null,
    deletedAt: null,
    deleteReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as GameCollection;

describe('GameCollectionService', () => {
  let service: GameCollectionService;
  let db: MockDatabaseService;
  let abilityService: jest.Mocked<
    Pick<AbilityService, 'getCurrentResourceConditions' | 'getActingUserId' | 'getCurrentAbilities'>
  >;

  beforeEach(async () => {
    abilityService = {
      getCurrentResourceConditions: jest.fn().mockReturnValue([COND]),
      getActingUserId: jest.fn().mockReturnValue(ME),
      getCurrentAbilities: jest.fn().mockReturnValue([{}]),
    };

    const ctx = await createTestingModuleWithDb({
      providers: [GameCollectionService, { provide: AbilityService, useValue: abilityService }],
    });

    db = ctx.db;
    service = ctx.module.get(GameCollectionService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('listOwn', () => {
    it('scopes to the acting user and excludes tombstones by default', async () => {
      db.gameCollection.findMany.mockResolvedValue([]);

      await service.listOwn({ offset: 0, limit: 20 });

      expect(db.gameCollection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: ME, AND: [COND], deletedAt: null }),
        }),
      );
    });

    it('includeDeleted lifts the tombstone filter', async () => {
      db.gameCollection.findMany.mockResolvedValue([]);

      await service.listOwn({ offset: 0, limit: 20, includeDeleted: true });

      const where = db.gameCollection.findMany.mock.calls[0][0]?.where;
      expect(where).not.toHaveProperty('deletedAt');
    });

    it('deletedOnly returns the resurrection view', async () => {
      db.gameCollection.findMany.mockResolvedValue([]);

      await service.listOwn({ offset: 0, limit: 20, deletedOnly: true });

      expect(db.gameCollection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ deletedAt: { not: null } }),
        }),
      );
    });

    it('applies medium, favorite, and updatedSince filters', async () => {
      db.gameCollection.findMany.mockResolvedValue([]);
      const updatedSince = new Date('2026-06-01');

      await service.listOwn({
        offset: 0,
        limit: 20,
        medium: GameMedium.Digital,
        favorite: false,
        updatedSince,
      });

      expect(db.gameCollection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            medium: GameMedium.Digital,
            favorite: false,
            updatedAt: { gte: updatedSince },
          }),
        }),
      );
    });
  });

  describe('listForUser', () => {
    it('applies CASL read conditions for an authenticated viewer', async () => {
      db.gameCollection.findMany.mockResolvedValue([]);

      await service.listForUser('user-2', { offset: 0, limit: 20 });

      expect(db.gameCollection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-2', deletedAt: null, AND: [COND] }),
        }),
      );
    });

    it('falls back to Public-only for an anonymous viewer', async () => {
      abilityService.getCurrentAbilities.mockReturnValue([]);
      db.gameCollection.findMany.mockResolvedValue([]);

      await service.listForUser('user-2', { offset: 0, limit: 20 });

      expect(db.gameCollection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ userId: 'user-2', deletedAt: null, visibility: Visibility.Public }),
        }),
      );
      expect(abilityService.getCurrentResourceConditions).not.toHaveBeenCalled();
    });
  });

  describe('getById', () => {
    it('returns a readable entry', async () => {
      db.gameCollection.findUnique.mockResolvedValue(entry());

      await expect(service.getById('gc-1')).resolves.toMatchObject({ id: 'gc-1' });
      expect(db.gameCollection.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'gc-1', AND: [COND] }) }),
      );
    });

    it('404s when the entry is not visible to the actor', async () => {
      db.gameCollection.findUnique.mockResolvedValue(null);

      await expect(service.getById('gc-404')).rejects.toThrow(NotFoundException);
    });
  });

  describe('addToCollection', () => {
    beforeEach(() => {
      db.platformGame.findUnique.mockResolvedValue({ id: 'pg-1' } as PlatformGame);
      db.gameCollection.upsert.mockResolvedValue(entry());
    });

    it('404s when the platform game does not exist', async () => {
      db.platformGame.findUnique.mockResolvedValue(null);

      await expect(service.addToCollection({ platformGameId: 'pg-404', medium: GameMedium.Physical })).rejects.toThrow(
        NotFoundException,
      );
      expect(db.gameCollection.upsert).not.toHaveBeenCalled();
    });

    it('upserts on the (user, platformGame, medium) identity', async () => {
      await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, quantity: 2 });

      expect(db.gameCollection.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_platformGameId_medium: { userId: ME, platformGameId: 'pg-1', medium: GameMedium.Physical } },
          create: expect.objectContaining({ userId: ME, platformGameId: 'pg-1', quantity: 2 }),
        }),
      );
    });

    it('resurrects a tombstoned entry without touching play history', async () => {
      await service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical });

      const { update } = db.gameCollection.upsert.mock.calls[0][0];
      expect(update).toMatchObject({ deletedAt: null, deleteReason: null });
      // Server-managed play history and unspecified fields must survive the cycle.
      expect(update).not.toHaveProperty('playCount');
      expect(update).not.toHaveProperty('lastPlayed');
      expect(update).not.toHaveProperty('favorite');
      expect(update).not.toHaveProperty('playAgain');
    });

    it('404s when the release does not exist', async () => {
      db.gameRelease.findUnique.mockResolvedValue(null);

      await expect(
        service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, releaseId: 'r-404' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('400s when the release belongs to a different platform game', async () => {
      db.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-other' } as GameRelease);

      await expect(
        service.addToCollection({ platformGameId: 'pg-1', medium: GameMedium.Physical, releaseId: 'r-1' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('update', () => {
    beforeEach(() => {
      db.gameCollection.findUnique.mockResolvedValue({ platformGameId: 'pg-1' } as GameCollection);
      db.gameCollection.update.mockResolvedValue(entry());
    });

    it('rejects an empty patch', async () => {
      await expect(service.update('gc-1', {})).rejects.toThrow(BadRequestException);
      expect(db.gameCollection.update).not.toHaveBeenCalled();
    });

    it('goes straight to the scoped update without a pre-read', async () => {
      await service.update('gc-1', { quantity: 2 });

      expect(db.gameCollection.findUnique).not.toHaveBeenCalled();
    });

    it('404s when the entry does not exist (or is not the actor’s)', async () => {
      db.gameCollection.update.mockRejectedValue(dependentRecordNotFound());

      await expect(service.update('gc-404', { quantity: 2 })).rejects.toThrow(NotFoundException);
    });

    it('passes explicit nulls through to clear nullable fields', async () => {
      await service.update('gc-1', { rating: null, comment: null, quantity: 2 });

      expect(db.gameCollection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'gc-1', AND: [COND] }),
          data: expect.objectContaining({ rating: null, comment: null, quantity: 2 }),
        }),
      );
    });

    it('omits fields the caller did not send', async () => {
      await service.update('gc-1', { favorite: true });

      const { data } = db.gameCollection.update.mock.calls[0][0];
      expect(data).not.toHaveProperty('rating');
      expect(data).not.toHaveProperty('comment');
      expect(data).not.toHaveProperty('quantity');
    });

    it('validates a new release against the entry’s platform game (scoped pre-read)', async () => {
      db.gameRelease.findUnique.mockResolvedValue({ platformGameId: 'pg-other' } as GameRelease);

      await expect(service.update('gc-1', { releaseId: 'r-1' })).rejects.toThrow(BadRequestException);
      expect(db.gameCollection.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'gc-1', AND: [COND] }) }),
      );
    });

    it('404s a release patch on a row outside the actor’s scope', async () => {
      db.gameCollection.findUnique.mockResolvedValue(null);

      await expect(service.update('gc-1', { releaseId: 'r-1' })).rejects.toThrow(NotFoundException);
      expect(db.gameCollection.update).not.toHaveBeenCalled();
    });

    it('uses update conditions, not read conditions, for the write', async () => {
      await service.update('gc-1', { quantity: 2 });

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.GameCollection,
        Action.update,
      );
    });
  });

  describe('remove', () => {
    beforeEach(() => {
      db.gameCollection.update.mockResolvedValue(entry({ deletedAt: new Date() }));
    });

    it('soft deletes with an optional reason in a single scoped write', async () => {
      await service.remove('gc-1', { reason: GameRemovalReason.Sold });

      expect(db.gameCollection.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'gc-1', deletedAt: null, AND: [COND] }),
          data: expect.objectContaining({ deletedAt: expect.any(Date), deleteReason: GameRemovalReason.Sold }),
        }),
      );
      // Never a hard delete — play history and child rows must survive.
      expect(db.gameCollection.delete).not.toHaveBeenCalled();
      // No pre-read: the `deletedAt: null` filter carries the state check.
      expect(db.gameCollection.findUnique).not.toHaveBeenCalled();
    });

    it('defaults the reason to null', async () => {
      await service.remove('gc-1', {});

      expect(db.gameCollection.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ deleteReason: null }) }),
      );
    });

    it('404s missing, already-removed, and foreign rows alike', async () => {
      db.gameCollection.update.mockRejectedValue(dependentRecordNotFound());

      await expect(service.remove('gc-404', {})).rejects.toThrow(NotFoundException);
    });

    it('uses delete conditions for the write', async () => {
      await service.remove('gc-1', {});

      expect(abilityService.getCurrentResourceConditions).toHaveBeenCalledWith(
        ResourceType.GameCollection,
        Action.delete,
      );
    });
  });
});
