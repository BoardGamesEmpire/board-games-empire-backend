import { MediaContributionStatus, Visibility, type MediaContribution, type MediaObject } from '@bge/database';
import { paginationQuery } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { firstValueFrom } from 'rxjs';
import { ListContributionsQueryDto } from './dto';
import { MediaContributionController } from './media-contribution.controller';
import { MediaObjectController } from './media-object.controller';

const mediaRow = {
  id: 'm-1',
  ownerId: 'u-1',
  uploaderId: 'u-1',
  visibility: Visibility.Public,
  mimeType: 'image/png',
  // A BigInt, which is exactly why the mapper has to run before the envelope:
  // JSON cannot carry it, so the public shape stringifies it.
  sizeBytes: 20480n,
  checksum: 'abc',
  etag: null,
  originalName: 'box.png',
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-02T00:00:00.000Z'),
  width: 800,
  height: 600,
  pageCount: null,
  driverSlug: 'local',
  driverKey: 'k',
} as unknown as MediaObject;

const contributionRow = {
  id: 'c-1',
  mediaObjectId: 'm-1',
  subjectType: 'Game',
  subjectId: 'g-1',
  category: 'box-art',
  status: MediaContributionStatus.Pending,
  origin: 'user',
  contributedById: 'u-1',
  reviewedById: null,
  reviewedAt: null,
  rejectionReason: null,
  reclaimDeadline: null,
  createdAt: new Date('2026-08-01T00:00:00.000Z'),
  updatedAt: new Date('2026-08-02T00:00:00.000Z'),
} as unknown as MediaContribution;

/**
 * The two media list reads map their rows to a public shape before wrapping
 * them (#372). That ordering is the thing worth pinning: the mapper is a
 * projection, so `total` still describes the set the rows came from, and the
 * envelope must carry mapped rows rather than raw model rows — one of which
 * holds a BigInt that would not survive serialization.
 */
describe('media list envelopes (#372)', () => {
  describe('GET /media-objects', () => {
    it('maps rows to the public shape, then wraps them with the requested paging', async () => {
      const media = { list: jest.fn().mockResolvedValue({ rows: [mediaRow], total: 31 }) };
      const controller = new MediaObjectController(media as never, {} as never, {} as never);

      const response = await firstValueFrom(controller.list(paginationQuery({ page: 2, limit: 10 })));

      expect(response).toEqual({
        media: [expect.objectContaining({ id: 'm-1', sizeBytes: '20480' })],
        pagination: { page: 2, limit: 10, total: 31, totalPages: 4, hasMore: true },
      });
    });

    it('reports the service total, not the length of the page it was handed', async () => {
      const media = { list: jest.fn().mockResolvedValue({ rows: [mediaRow], total: 31 }) };
      const controller = new MediaObjectController(media as never, {} as never, {} as never);

      const response = (await firstValueFrom(controller.list(paginationQuery({ limit: 10 })))) as {
        pagination: { total: number };
      };

      expect(response.pagination.total).toBe(31);
    });
  });

  describe('GET /media-contributions', () => {
    it('maps rows to the public shape, then wraps them with the requested paging', async () => {
      const contributions = { list: jest.fn().mockResolvedValue({ rows: [contributionRow], total: 6 }) };
      const controller = new MediaContributionController(contributions as never);
      const query = plainToInstance(
        ListContributionsQueryDto,
        { status: MediaContributionStatus.Pending, limit: 5 },
        { enableImplicitConversion: true },
      );

      const response = await firstValueFrom(controller.list(query));

      expect(response).toEqual({
        contributions: [expect.objectContaining({ id: 'c-1', reviewedAt: null })],
        pagination: { page: 1, limit: 5, total: 6, totalPages: 2, hasMore: true },
      });
      expect(contributions.list).toHaveBeenCalledWith(query);
    });
  });
});
