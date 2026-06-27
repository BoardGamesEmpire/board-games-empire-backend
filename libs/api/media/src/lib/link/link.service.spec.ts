import { Action, Prisma, ResourceType } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import type { MockAbilityService, MockDatabaseService } from '@bge/testing';
import { createMockAbilityService, createTestingModuleWithDb } from '@bge/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { MediaLinkService } from './link.service';

describe('MediaLinkService', () => {
  let service: MediaLinkService;
  let db: MockDatabaseService;
  let ability: MockAbilityService;

  beforeEach(async () => {
    ability = createMockAbilityService();
    const ctx = await createTestingModuleWithDb({
      providers: [MediaLinkService, { provide: AbilityService, useValue: ability }],
    });
    db = ctx.db;
    service = ctx.module.get(MediaLinkService);

    db.$transaction.mockImplementation((cb) => cb(db));
    db.media.upsert.mockResolvedValue({ id: 'media-1' } as never);
  });

  describe('attach', () => {
    // Default happy-path wiring; individual tests override as needed.
    beforeEach(() => {
      db.mediaObject.findUnique
        .mockResolvedValueOnce({ id: 'mo1' } as never) // update-access check
        .mockResolvedValueOnce({ mimeType: 'image/png' } as never); // attachWithin mime read
      db.game.findUnique.mockResolvedValue({ id: 'g1' } as never); // subject-update access
      db.gameImage.findFirst.mockResolvedValue(null); // not yet attached
      db.gameImage.create.mockResolvedValue({ id: 'gi1' } as never);
    });

    it('rejects when the caller cannot update the media object', async () => {
      db.mediaObject.findUnique.mockReset().mockResolvedValueOnce(null);
      await expect(service.attach('mo1', { subjectType: ResourceType.Game, subjectId: 'g1' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('forbids attaching when the caller cannot update the subject', async () => {
      db.game.findUnique.mockResolvedValue(null);
      await expect(service.attach('mo1', { subjectType: ResourceType.Game, subjectId: 'g1' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(ability.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.Game, Action.update);
    });

    it('rejects an unsupported subject type with 400', async () => {
      await expect(
        service.attach('mo1', { subjectType: ResourceType.Notification, subjectId: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a non-linkable media kind (video)', async () => {
      db.mediaObject.findUnique
        .mockReset()
        .mockResolvedValueOnce({ id: 'mo1' } as never)
        .mockResolvedValueOnce({ mimeType: 'video/mp4' } as never);
      await expect(service.attach('mo1', { subjectType: ResourceType.Game, subjectId: 'g1' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('upserts the Media row and dispatches to the GameImage handler', async () => {
      const result = await service.attach('mo1', {
        subjectType: ResourceType.Game,
        subjectId: 'g1',
        context: { isCover: true },
      });
      expect(db.media.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { mediaObjectId: 'mo1' } }));
      expect(db.gameImage.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ mediaId: 'media-1', gameId: 'g1', isCover: true }) }),
      );
      expect(result).toMatchObject({ attachmentId: 'gi1', subjectType: ResourceType.Game });
    });

    it('is idempotent — returns the existing attachment instead of duplicating', async () => {
      db.gameImage.findFirst.mockResolvedValue({ id: 'gi-existing' } as never);
      const result = await service.attach('mo1', { subjectType: ResourceType.Game, subjectId: 'g1' });
      expect(db.gameImage.create).not.toHaveBeenCalled();
      expect(result).toMatchObject({ attachmentId: 'gi-existing' });
    });
  });

  describe('attachWithin (contribution path — no subject-auth)', () => {
    it('maps a missing subject (FK violation) to NotFound', async () => {
      db.mediaObject.findUnique.mockResolvedValue({ mimeType: 'image/png' } as never);
      db.gameImage.findFirst.mockResolvedValue(null);
      db.gameImage.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: '7' }),
      );
      await expect(
        service.attachWithin(db as never, 'mo1', { subjectType: ResourceType.Game, subjectId: 'nope' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('detach', () => {
    beforeEach(() => {
      db.mediaObject.findUnique.mockResolvedValue({ mimeType: 'image/png', media: { id: 'media-1' } } as never);
      db.game.findUnique.mockResolvedValue({ id: 'g1' } as never);
    });

    it('removes the join rows via the resolved handler', async () => {
      db.gameImage.deleteMany.mockResolvedValue({ count: 1 } as never);
      await expect(service.detach('mo1', { subjectType: ResourceType.Game, subjectId: 'g1' })).resolves.toEqual({
        removed: 1,
      });
    });

    it('forbids detaching when the caller cannot update the subject', async () => {
      db.game.findUnique.mockResolvedValue(null);
      await expect(service.detach('mo1', { subjectType: ResourceType.Game, subjectId: 'g1' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('is a no-op when the object was never attached', async () => {
      db.mediaObject.findUnique.mockResolvedValue({ mimeType: 'image/png', media: null } as never);
      await expect(service.detach('mo1', { subjectType: ResourceType.Game, subjectId: 'g1' })).resolves.toEqual({
        removed: 0,
      });
    });
  });
});
