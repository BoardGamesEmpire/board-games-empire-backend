jest.mock('image-size', () => ({ imageSize: jest.fn(() => ({ width: 800, height: 600, type: 'png' })) }));
import { imageSize } from 'image-size';

import type { MediaObject } from '@bge/database';
import { Action, ContributionOrigin, Prisma, QuotaScope, ResourceType, Visibility } from '@bge/database';
import { AbilityService } from '@bge/permissions';
import { QuotaExceededException, QuotaService } from '@bge/quota';
import { MediaUrlSigner, StorageService } from '@bge/storage';
import type { MockAbilityService, MockDatabaseService } from '@bge/testing';
import {
  createMockAbilityService,
  createTestingModuleWithDb,
  MOCK_ACTING_USER_ID,
  MOCK_RESOURCE_CONDITION,
} from '@bge/testing';
import type { StoredObject } from '@boardgamesempire/storage-contract';
import { ObjectNotFoundError, SignatureExpiredError, SignatureInvalidError } from '@boardgamesempire/storage-contract';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Readable } from 'node:stream';
import { UploadedMediaFile } from './dto';
import { MediaLinkService } from './link/link.service';
import { MediaContributionService } from './media-contribution.service';
import { MediaObjectService } from './media-object.service';

describe('MediaObjectService', () => {
  let service: MediaObjectService;
  let db: MockDatabaseService;
  let ability: MockAbilityService;
  let storage: jest.Mocked<Pick<StorageService, 'put' | 'get' | 'delete' | 'signedUrl' | 'driverSlug'>>;
  let signer: jest.Mocked<Pick<MediaUrlSigner, 'verify'>>;
  let quota: jest.Mocked<Pick<QuotaService, 'check' | 'consume'>>;
  let contributions: jest.Mocked<Pick<MediaContributionService, 'createContributionWithin'>>;
  let mediaLink: jest.Mocked<Pick<MediaLinkService, 'canLink'>>;

  const stored: StoredObject = {
    key: 'k',
    size: 1234n,
    contentType: 'image/png',
    checksum: 'sha',
    etag: 'sha',
    lastModified: new Date(0),
    driverSlug: 'localdisk',
  };
  const row = {
    id: 'm1',
    ownerId: MOCK_ACTING_USER_ID,
    uploaderId: MOCK_ACTING_USER_ID,
    mimeType: 'image/png',
    driverKey: 'users/u/m1',
    driverSlug: 'localdisk',
    sizeBytes: 1234n,
    checksum: 'sha',
    etag: 'sha',
    visibility: Visibility.Private,
    originalName: 'cat.png',
    pageCount: 1,
    width: 800,
    height: 600,
    duration: null,
    codec: null,
    resolution: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } satisfies MediaObject;

  const file: UploadedMediaFile = { buffer: Buffer.from('x'), mimetype: 'image/png', originalname: 'cat.png', size: 1 };

  beforeEach(async () => {
    contributions = { createContributionWithin: jest.fn().mockResolvedValue({ id: 'c1' }) };
    mediaLink = { canLink: jest.fn().mockReturnValue(true) };

    jest.mocked(imageSize).mockReturnValue({ width: 800, height: 600, type: 'png' });

    ability = createMockAbilityService();
    storage = {
      put: jest.fn(),
      get: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      signedUrl: jest.fn(),
      driverSlug: 'localdisk',
    };
    signer = { verify: jest.fn() };

    const allowed = {
      allowed: true,
      scope: null,
      currentUsage: null,
      limit: null,
      softOverage: false,
      constraints: [],
    };

    quota = { check: jest.fn().mockResolvedValue(allowed), consume: jest.fn().mockResolvedValue(allowed) };
    const config = { getOrThrow: jest.fn().mockReturnValue({ signedUrlTtlSeconds: 300 }) };

    const ctx = await createTestingModuleWithDb({
      providers: [
        MediaObjectService,
        { provide: AbilityService, useValue: ability },
        { provide: StorageService, useValue: storage },
        { provide: MediaUrlSigner, useValue: signer },
        { provide: ConfigService, useValue: config },
        { provide: QuotaService, useValue: quota },
        { provide: MediaContributionService, useValue: contributions },
        { provide: MediaLinkService, useValue: mediaLink },
      ],
    });

    db = ctx.db;
    db.$transaction.mockImplementation((cb) => cb(db)); // run the tx body with db as the client
    service = ctx.module.get(MediaObjectService);
  });

  afterEach(() => {
    jest.resetAllMocks();
    jest.clearAllMocks();
  });

  describe('upload', () => {
    it('puts under an uploader-anchored key, then persists the row', async () => {
      storage.put.mockResolvedValue(stored);
      db.mediaObject.create.mockResolvedValue(row);

      await expect(service.upload(file)).resolves.toBe(row);

      expect(storage.put).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(`^users/${MOCK_ACTING_USER_ID}/`)),
        file.buffer,
        expect.objectContaining({ contentType: 'image/png', originalName: 'cat.png' }),
      );
      expect(db.mediaObject.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ownerId: MOCK_ACTING_USER_ID,
          uploaderId: MOCK_ACTING_USER_ID,
          visibility: Visibility.Private,
          driverSlug: 'localdisk',
          sizeBytes: 1234n,
          checksum: 'sha',
          mimeType: 'image/png',
        }),
      });
    });

    it('cleans up bytes if the row fails to persist', async () => {
      storage.put.mockResolvedValue(stored);
      db.mediaObject.create.mockRejectedValue(new Error('db down'));

      await expect(service.upload(file)).rejects.toThrow('db down');
      expect(storage.delete).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^users/${MOCK_ACTING_USER_ID}/`)));
    });

    it('rejects a disallowed media type on upload', async () => {
      await expect(service.upload({ ...file, mimetype: 'text/html' })).rejects.toBeInstanceOf(
        UnsupportedMediaTypeException,
      );
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('checks the storage quota for the acting user before writing bytes', async () => {
      storage.put.mockResolvedValue(stored);
      db.mediaObject.create.mockResolvedValue(row);

      await service.upload(file);

      expect(quota.check).toHaveBeenCalledWith('storage_bytes', BigInt(file.buffer.byteLength), {
        userId: MOCK_ACTING_USER_ID,
      });
    });

    it('rejects an over-quota upload before touching storage', async () => {
      quota.check.mockResolvedValue({
        allowed: false,
        scope: QuotaScope.User,
        currentUsage: 100n,
        limit: 100n,
        softOverage: false,
        constraints: [],
      });

      await expect(service.upload(file)).rejects.toBeInstanceOf(QuotaExceededException);
      expect(storage.put).not.toHaveBeenCalled();
      expect(db.mediaObject.create).not.toHaveBeenCalled();
    });

    it('guards on input length up front, then consumes the authoritative stored size atomically', async () => {
      storage.put.mockResolvedValue(stored); // stored.size = 1234n
      db.mediaObject.create.mockResolvedValue(row);

      await service.upload(file); // 1-byte buffer

      expect(quota.check).toHaveBeenCalledWith('storage_bytes', 1n, { userId: MOCK_ACTING_USER_ID });
      expect(quota.consume).toHaveBeenCalledWith('storage_bytes', 1234n, { userId: MOCK_ACTING_USER_ID }, db);
    });

    it('deletes the written bytes if the authoritative size pushes over quota', async () => {
      storage.put.mockResolvedValue(stored);
      quota.consume.mockResolvedValue({
        allowed: false,
        scope: QuotaScope.User,
        currentUsage: 100n,
        limit: 100n,
        softOverage: false,
        constraints: [],
      });

      await expect(service.upload(file)).rejects.toBeInstanceOf(QuotaExceededException);
      expect(storage.put).toHaveBeenCalled();
      expect(storage.delete).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^users/${MOCK_ACTING_USER_ID}/`)));
      expect(db.mediaObject.create).not.toHaveBeenCalled();
    });

    it('probes and stores dimensions for an image upload', async () => {
      storage.put.mockResolvedValue(stored);
      db.mediaObject.create.mockResolvedValue(row);

      await service.upload(file); // file.mimetype = 'image/png'

      expect(db.mediaObject.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ width: 800, height: 600 }) }),
      );
    });

    it('stores null dimensions for a non-image upload', async () => {
      (imageSize as jest.Mock).mockClear();
      storage.put.mockResolvedValue(stored);
      db.mediaObject.create.mockResolvedValue({
        ...row,
        mimeType: 'application/pdf',
        width: null,
        height: null,
      });
      await service.upload({ ...file, mimetype: 'application/pdf' });
      expect(imageSize).not.toHaveBeenCalled();
      expect(db.mediaObject.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ width: null, height: null }) }),
      );
    });
  });

  describe('uploadAndContribute', () => {
    const contributeDto = { subjectType: ResourceType.Game, subjectId: 'g1', category: 'rulebook' };

    it('uploads, creates the object, and records a DirectUpload contribution', async () => {
      storage.put.mockResolvedValue(stored);
      db.mediaObject.create.mockResolvedValue(row);

      const result = await service.uploadAndContribute(file, contributeDto);

      expect(storage.put).toHaveBeenCalled();
      expect(contributions.createContributionWithin).toHaveBeenCalledWith(
        db, // tx === db via the $transaction mock
        expect.any(String), // the freshly minted object id
        contributeDto,
        ContributionOrigin.DirectUpload,
        MOCK_ACTING_USER_ID,
      );
      expect(result).toEqual({ media: row, contribution: { id: 'c1' } });
    });

    it('fails fast before writing bytes when the type cannot be linked', async () => {
      mediaLink.canLink.mockReturnValueOnce(false);
      await expect(service.uploadAndContribute(file, contributeDto)).rejects.toBeInstanceOf(BadRequestException);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('rejects a disallowed media type', async () => {
      await expect(
        service.uploadAndContribute({ ...file, mimetype: 'text/html' }, contributeDto),
      ).rejects.toBeInstanceOf(UnsupportedMediaTypeException);
      expect(storage.put).not.toHaveBeenCalled();
    });

    it('compensates stored bytes and does not contribute when over quota', async () => {
      storage.put.mockResolvedValue(stored);
      quota.consume.mockResolvedValue({
        allowed: false,
        scope: QuotaScope.User,
        currentUsage: 100n,
        limit: 100n,
        softOverage: false,
        constraints: [],
      });

      await expect(service.uploadAndContribute(file, contributeDto)).rejects.toBeInstanceOf(QuotaExceededException);
      expect(storage.delete).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^users/${MOCK_ACTING_USER_ID}/`)));
      expect(contributions.createContributionWithin).not.toHaveBeenCalled();
    });

    it('compensates stored bytes if the contribution fails', async () => {
      storage.put.mockResolvedValue(stored);
      db.mediaObject.create.mockResolvedValue(row);
      contributions.createContributionWithin.mockRejectedValueOnce(new ConflictException('dup'));

      await expect(service.uploadAndContribute(file, contributeDto)).rejects.toBeInstanceOf(ConflictException);
      expect(storage.delete).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^users/${MOCK_ACTING_USER_ID}/`)));
    });
  });

  describe('findById', () => {
    it('applies read conditions and returns the row', async () => {
      db.mediaObject.findUnique.mockResolvedValue(row);
      await expect(service.findById('m1')).resolves.toBe(row);
      expect(ability.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.MediaObject, Action.read);
      expect(db.mediaObject.findUnique).toHaveBeenCalledWith({ where: { id: 'm1', AND: [MOCK_RESOURCE_CONDITION] } });
    });

    it('throws NotFound when absent or inaccessible', async () => {
      db.mediaObject.findUnique.mockResolvedValue(null);
      await expect(service.findById('m1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('createSignedUrl', () => {
    it('mints a GET URL bound to mime + owner', async () => {
      db.mediaObject.findUnique.mockResolvedValue(row);
      storage.signedUrl.mockResolvedValue({ url: 'https://x', expiresAt: new Date(0), method: 'GET' });

      await service.createSignedUrl('m1');
      expect(storage.signedUrl).toHaveBeenCalledWith('users/u/m1', 'get', {
        ttlSeconds: 300,
        contentType: 'image/png',
        bindings: { ownerId: MOCK_ACTING_USER_ID },
      });
    });
  });

  describe('delete', () => {
    it('deletes the row (access-checked) then the bytes', async () => {
      db.mediaObject.delete.mockResolvedValue(row);
      await service.delete('m1');
      expect(ability.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.MediaObject, Action.delete);
      expect(storage.delete).toHaveBeenCalledWith('users/u/m1');
    });

    it('maps a missing/forbidden row to NotFound', async () => {
      db.mediaObject.delete.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('x', { code: 'P2025', clientVersion: '7' }),
      );
      await expect(service.delete('m1')).rejects.toBeInstanceOf(NotFoundException);
      expect(storage.delete).not.toHaveBeenCalled();
    });
  });

  describe('getVerifiedStream', () => {
    const query = { key: 'users/u/m1', op: 'get', exp: '9999999999', sig: 'deadbeef' } as const;

    beforeEach(() => db.mediaObject.findUnique.mockResolvedValue(row));

    it('verifies and returns the stream', async () => {
      signer.verify.mockResolvedValue(undefined);
      storage.get.mockResolvedValue({ body: Readable.from(Buffer.from('x')), metadata: stored });

      const result = await service.getVerifiedStream(query);
      expect(result.contentType).toBe('image/png');
      expect(signer.verify).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'users/u/m1',
          op: 'get',
          expiresAt: 9999999999,
          contentType: 'image/png',
          bindings: { ownerId: MOCK_ACTING_USER_ID },
        }),
        'deadbeef',
      );
    });

    it('returns 403 (not 404) for an unknown key — no existence oracle', async () => {
      db.mediaObject.findUnique.mockResolvedValue(null);
      await expect(service.getVerifiedStream(query)).rejects.toBeInstanceOf(ForbiddenException);
      expect(signer.verify).not.toHaveBeenCalled();
    });

    it('serves inline-safe types inline and others as attachment', async () => {
      signer.verify.mockResolvedValue(undefined);
      storage.get.mockResolvedValue({ body: Readable.from(Buffer.from('x')), metadata: stored });

      db.mediaObject.findUnique.mockResolvedValue({
        ownerId: 'u1',
        mimeType: 'image/png',
        originalName: 'a.png',
      } as never);
      await expect(service.getVerifiedStream(query)).resolves.toMatchObject({
        contentDisposition: expect.stringMatching(/^inline;/),
      });

      db.mediaObject.findUnique.mockResolvedValue({
        ownerId: 'u1',
        mimeType: 'text/plain',
        originalName: 'a.txt',
      } as never);
      await expect(service.getVerifiedStream(query)).resolves.toMatchObject({
        contentDisposition: expect.stringMatching(/^attachment;/),
      });
    });

    it('maps an expired signature to 410 Gone', async () => {
      signer.verify.mockRejectedValue(new SignatureExpiredError());
      await expect(service.getVerifiedStream(query)).rejects.toBeInstanceOf(GoneException);
    });

    it('maps an invalid signature to 403 Forbidden', async () => {
      signer.verify.mockRejectedValue(new SignatureInvalidError());
      await expect(service.getVerifiedStream(query)).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('404s when the row exists but bytes are gone', async () => {
      signer.verify.mockResolvedValue(undefined);
      storage.get.mockRejectedValue(new ObjectNotFoundError('users/u/m1'));
      await expect(service.getVerifiedStream(query)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
