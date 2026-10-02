jest.mock('image-size', () => ({ imageSize: jest.fn(() => ({ width: 800, height: 600, type: 'png' })) }));
import { imageSize } from 'image-size';

import type { MediaObject } from '@bge/database';
import { Action, ContributionOrigin, Prisma, QuotaScope, ResourceType, Visibility } from '@bge/database';
import { t } from '@bge/i18n';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import { QuotaExceededException, QuotaService } from '@bge/quota';
import { MediaUrlSigner, StorageService } from '@bge/storage';
import type { MockAbilityService, MockDatabaseService } from '@bge/testing';
import {
  batchTransactionCall,
  createMockAbilityService,
  createTestingModuleWithDb,
  MOCK_ACTING_USER_ID,
  MOCK_RESOURCE_CONDITION,
  paginationQuery,
  unwrapTransaction,
} from '@bge/testing';
import type { StoredObject } from '@boardgamesempire/storage-contract';
import {
  DriverNotRegisteredError,
  ObjectNotFoundError,
  SignatureExpiredError,
  SignatureInvalidError,
} from '@boardgamesempire/storage-contract';
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
  let storage: jest.Mocked<Pick<StorageService, 'put' | 'get' | 'delete' | 'signedUrl'>>;
  let signer: jest.Mocked<Pick<MediaUrlSigner, 'verify'>>;
  let quota: jest.Mocked<Pick<QuotaService, 'check' | 'consume' | 'emitSoftOverages'>>;
  let contributions: jest.Mocked<Pick<MediaContributionService, 'createContributionWithin'>>;
  let mediaLink: jest.Mocked<Pick<MediaLinkService, 'canLink'>>;
  let compose: jest.SpyInstance;

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
    };
    signer = { verify: jest.fn() };

    const allowed = {
      allowed: true,
      scope: null,
      currentUsage: null,
      limit: null,
      softOverage: false,
      constraints: [],
      softOverages: [],
    };

    quota = {
      check: jest.fn().mockResolvedValue(allowed),
      consume: jest.fn().mockResolvedValue(allowed),
      emitSoftOverages: jest.fn(),
    };
    const config = { getOrThrow: jest.fn().mockReturnValue({ signedUrlTtlSeconds: 300 }) };

    const ctx = await createTestingModuleWithDb({
      providers: [
        MediaObjectService,
        // The REAL composer, over the mocked ability service, so the list's
        // where clause asserted below is the merge it actually runs.
        ScopeComposer,
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
    // This service does both: the upload path wraps its writes in a callback
    // transaction, and the paginated list reads rows + count as an array batch.
    unwrapTransaction(db);
    service = ctx.module.get(MediaObjectService);
    compose = jest.spyOn(ctx.module.get(ScopeComposer), 'compose');
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
      expect(storage.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          driverSlug: 'localdisk',
          driverKey: expect.stringMatching(new RegExp(`^users/${MOCK_ACTING_USER_ID}/`)),
        }),
      );
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
        softOverages: [],
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
        softOverages: [],
      });

      await expect(service.upload(file)).rejects.toBeInstanceOf(QuotaExceededException);
      expect(storage.put).toHaveBeenCalled();
      expect(storage.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          driverSlug: 'localdisk',
          driverKey: expect.stringMatching(new RegExp(`^users/${MOCK_ACTING_USER_ID}/`)),
        }),
      );
      expect(db.mediaObject.create).not.toHaveBeenCalled();
    });

    it('emits collected soft-overage warnings only after the row is persisted (post-commit hand-off)', async () => {
      storage.put.mockResolvedValue(stored);
      db.mediaObject.create.mockResolvedValue(row);
      const warning = {
        scope: QuotaScope.User,
        scopeId: MOCK_ACTING_USER_ID,
        resource: 'storage_bytes' as const,
        currentUsage: '900',
        attemptedAmount: '1234',
        limit: '1000',
      };
      quota.consume.mockResolvedValue({
        allowed: true,
        scope: QuotaScope.User,
        currentUsage: 900n,
        limit: 1000n,
        softOverage: true,
        constraints: [],
        softOverages: [warning],
      });

      await service.upload(file);

      expect(quota.emitSoftOverages).toHaveBeenCalledWith([warning]);
      const createOrder = db.mediaObject.create.mock.invocationCallOrder[0];
      const emitOrder = (quota.emitSoftOverages as jest.Mock).mock.invocationCallOrder[0];
      expect(emitOrder).toBeGreaterThan(createOrder); // never emitted before the write lands
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
      const postFlip = { ...row, visibility: Visibility.Public, ownerId: 'svc' };
      storage.put.mockResolvedValue(stored);
      db.mediaObject.create.mockResolvedValue(row); // pre-flip
      db.mediaObject.findUniqueOrThrow.mockResolvedValue(postFlip); // post-flip re-read

      const result = await service.uploadAndContribute(file, contributeDto);

      expect(contributions.createContributionWithin).toHaveBeenCalledWith(
        db,
        expect.any(String),
        contributeDto,
        ContributionOrigin.DirectUpload,
        MOCK_ACTING_USER_ID,
      );
      expect(result).toEqual({ media: postFlip, contribution: { id: 'c1' } });
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
        softOverages: [],
      });

      await expect(service.uploadAndContribute(file, contributeDto)).rejects.toBeInstanceOf(QuotaExceededException);
      expect(storage.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          driverSlug: 'localdisk',
          driverKey: expect.stringMatching(new RegExp(`^users/${MOCK_ACTING_USER_ID}/`)),
        }),
      );
      expect(contributions.createContributionWithin).not.toHaveBeenCalled();
    });

    it('compensates stored bytes if the contribution fails', async () => {
      storage.put.mockResolvedValue(stored);
      db.mediaObject.create.mockResolvedValue(row);
      contributions.createContributionWithin.mockRejectedValueOnce(new ConflictException('dup'));

      await expect(service.uploadAndContribute(file, contributeDto)).rejects.toBeInstanceOf(ConflictException);
      expect(storage.delete).toHaveBeenCalledWith(
        expect.objectContaining({
          driverSlug: 'localdisk',
          driverKey: expect.stringMatching(new RegExp(`^users/${MOCK_ACTING_USER_ID}/`)),
        }),
      );
    });

    it('never emits soft-overage when the contribution rolls the tx back', async () => {
      storage.put.mockResolvedValue(stored);
      db.mediaObject.create.mockResolvedValue(row);
      quota.consume.mockResolvedValue({
        allowed: true,
        scope: QuotaScope.User,
        currentUsage: 900n,
        limit: 1000n,
        softOverage: true,
        constraints: [],
        softOverages: [
          {
            scope: QuotaScope.User,
            scopeId: MOCK_ACTING_USER_ID,
            resource: 'storage_bytes',
            currentUsage: '900',
            attemptedAmount: '1234',
            limit: '1000',
          },
        ],
      });
      contributions.createContributionWithin.mockRejectedValueOnce(new ConflictException('dup'));

      await expect(service.uploadAndContribute(file, contributeDto)).rejects.toBeInstanceOf(ConflictException);
      // The write rolled back — the warning it would have raised must not fire.
      expect(quota.emitSoftOverages).not.toHaveBeenCalled();
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
      expect(storage.signedUrl).toHaveBeenCalledWith({ driverSlug: 'localdisk', driverKey: 'users/u/m1' }, 'get', {
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
      expect(storage.delete).toHaveBeenCalledWith({ driverSlug: 'localdisk', driverKey: 'users/u/m1' });
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
    const query = { slug: 'localdisk', key: 'users/u/m1', op: 'get', exp: '9999999999', sig: 'deadbeef' } as const;

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

    it('verifies and resolves row + bytes by the URL slug, then returns the stream', async () => {
      signer.verify.mockResolvedValue(undefined);
      storage.get.mockResolvedValue({ body: Readable.from(Buffer.from('x')), metadata: stored });

      const result = await service.getVerifiedStream(query);
      expect(result.contentType).toBe('image/png');

      expect(db.mediaObject.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { driverSlug_driverKey: { driverSlug: 'localdisk', driverKey: 'users/u/m1' } },
        }),
      );
      expect(storage.get).toHaveBeenCalledWith({ driverSlug: 'localdisk', driverKey: 'users/u/m1' });
      expect(signer.verify).toHaveBeenCalledWith(
        expect.objectContaining({
          slug: 'localdisk',
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

    it('404s when the recorded driver is no longer configured (#100)', async () => {
      signer.verify.mockResolvedValue(undefined);
      storage.get.mockRejectedValue(new DriverNotRegisteredError('localdisk'));
      await expect(service.getVerifiedStream(query)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  /**
   * #514. `GET /media` took the caller's ceiling as its answer set, so it
   * listed a user their own media plus every other user's Public media, and
   * staff every object on the server, `read:public_content` being a read on
   * `all`. It now declares the caller's own media, and the ceiling only clips
   * it. Another user's media stays readable by id for whoever could read it
   * before. It is narrowed out of the list, not withdrawn.
   *
   * `MediaObject` has left `PENDING_SCOPE_SWEEP`, so a regression that stops
   * this read composing answers 500 at the envelope rather than returning too
   * much. That is why the first test pins the composer call itself.
   */
  describe('list', () => {
    beforeEach(() => {
      db.mediaObject.findMany.mockResolvedValue([]);
      db.mediaObject.count.mockResolvedValue(0);
    });

    it("asks the composer for its where clause, declaring the caller's own media", async () => {
      await service.list(paginationQuery({ limit: 10 }));

      expect(compose).toHaveBeenCalledWith(ResourceType.MediaObject, Action.read, { ownerId: MOCK_ACTING_USER_ID });
    });

    // Asking is not enough: the query has to use the answer. The ceiling stays
    // ANDed in, because for an `apiKey` actor it carries the key ∩ owner floor.
    it('queries with the composed clause, the ceiling clipping its scope rather than supplying it', async () => {
      await service.list(paginationQuery({ limit: 10 }));

      expect(ability.getCurrentResourceConditions).toHaveBeenCalledWith(ResourceType.MediaObject, Action.read);
      expect(db.mediaObject.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { ownerId: MOCK_ACTING_USER_ID, AND: [MOCK_RESOURCE_CONDITION] } }),
      );
    });

    // #372: one snapshot for rows and count, and the count has to see the same
    // clause, or `total` describes a set the caller is not paged through.
    it('counts through the same where as the rows, in one REPEATABLE READ transaction', async () => {
      db.mediaObject.count.mockResolvedValue(9);

      const page = await service.list(paginationQuery({ limit: 10 }));

      const [findManyArgs] = db.mediaObject.findMany.mock.calls[0] as [{ where: unknown }];
      expect(db.mediaObject.count).toHaveBeenCalledWith({ where: findManyArgs.where });
      expect(page).toEqual({ rows: [], total: 9 });

      const { operations, options } = batchTransactionCall(db);
      expect(operations).toHaveLength(2);
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    });

    // PROVISIONAL (#395). "My media" has no meaning for an actor with no user
    // behind it, and the refusal must stay one: an empty page would tell a
    // client it owns nothing. Before #514 such an actor received whatever its
    // ceiling admitted.
    it('refuses an actor kind with no user behind it rather than answering an empty page', async () => {
      ability.getActingUserId.mockImplementation(() => {
        throw new ForbiddenException(t('errors.actor_context.not_user_attributable', { kind: 'plugin' }));
      });

      const rejection: unknown = await service.list(paginationQuery({ limit: 10 })).catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ForbiddenException);
      expect((rejection as ForbiddenException).getResponse()).toEqual(t('common.forbidden.access'));
      expect(db.mediaObject.findMany).not.toHaveBeenCalled();
    });
  });
});
