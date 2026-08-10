import type { FeedbackReport, Permission, SystemSetting, User } from '@bge/database';
import {
  DeploymentRuntime,
  FeedbackCategory,
  FeedbackContext,
  FeedbackSeverity,
  FeedbackStatus,
  Prisma,
  ResourceType,
} from '@bge/database';
import { uniqueViolation as sharedUniqueViolation, uniqueViolationWithoutMeta } from '@bge/database/testing';
import { DeploymentInfoService } from '@bge/services';
import { createTestingModuleWithDb, MockDatabaseService } from '@bge/testing';
import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DateTime } from 'luxon';
import { FeedbackEvents } from './constants/feedback-events.constant';
import { FEEDBACK_CLIENT_REQUEST_ID_CONSTRAINT, FEEDBACK_CREATE_PERMISSION_SLUG } from './constants/feedback.constants';
import { BreadcrumbLogLevel, type BreadcrumbDto } from './dto/breadcrumb.dto';
import { CreateFeedbackReportDto } from './dto/create-feedback-report.dto';
import { FeedbackService } from './feedback.service';
import type {
  FeedbackReportPurgedEvent,
  FeedbackReportSubmittedEvent,
  UserFeedbackBannedEvent,
  UserFeedbackUnbannedEvent,
} from './interfaces/feedback.interface';
import { RedactionService } from './services/redaction.service';

/**
 * Assertions go through `expect.objectContaining` on `toHaveBeenCalledWith`
 * rather than casting `mock.calls[0][0]` to a hand-rolled shape — the cast
 * pattern collides with Prisma's input-type unions (especially for `Json`
 * columns) and reads as line noise. Use `objectContaining` for all
 * mock-call assertions in this file going forward.
 */

const CREATE_PERMISSION_ID = 'perm-create-feedback-report';

describe('FeedbackService', () => {
  let service: FeedbackService;
  let db: MockDatabaseService;
  let events: jest.Mocked<Pick<EventEmitter2, 'emit'>>;
  let redaction: jest.Mocked<Pick<RedactionService, 'scrubString' | 'scrubObject'>>;
  let deployment: jest.Mocked<Pick<DeploymentInfoService, 'getInfo'>>;

  beforeEach(async () => {
    events = { emit: jest.fn() };
    redaction = {
      scrubString: jest.fn((input: string) => ({ value: input, mutated: false })),
      scrubObject: jest.fn((input: Record<string, unknown> | null | undefined) => ({
        value: input ?? null,
        mutated: false,
      })),
    };
    deployment = {
      getInfo: jest.fn(() => ({ runtime: DeploymentRuntime.Kubernetes, version: '0.4.1' })),
    };

    const { module, db: mockDb } = await createTestingModuleWithDb({
      providers: [
        FeedbackService,
        { provide: EventEmitter2, useValue: events },
        { provide: RedactionService, useValue: redaction },
        { provide: DeploymentInfoService, useValue: deployment },
      ],
    });

    service = module.get(FeedbackService);
    db = mockDb;

    db.systemSetting.findFirst.mockResolvedValue(stubSettings());
    db.permission.findUnique.mockResolvedValue({ id: CREATE_PERMISSION_ID } as Permission);
    db.feedbackReport.create.mockResolvedValue(stubReport());
  });

  afterEach(() => jest.clearAllMocks());

  describe('submit', () => {
    it('persists an authenticated bug report and connects the submitter', async () => {
      const created = stubReport({ id: 'fb-1', userId: 'user-1' });
      db.feedbackReport.create.mockResolvedValue(created);

      const result = await service.submit('user-1', makeDto());

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            message: 'Crash on add-to-collection',
            category: FeedbackCategory.Bug,
            severity: FeedbackSeverity.High,
            user: { connect: { id: 'user-1' } },
          }),
        }),
      );
      expect(result).toBe(created);
    });

    it('stamps the report with the current deployment runtime + version', async () => {
      db.feedbackReport.create.mockResolvedValue(stubReport());
      deployment.getInfo.mockReturnValue({ runtime: DeploymentRuntime.DockerCompose, version: '0.5.0' });

      await service.submit('user-1', makeDto());

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            deploymentRuntime: DeploymentRuntime.DockerCompose,
            deploymentVersion: '0.5.0',
          }),
        }),
      );
    });

    it('defaults context to Unknown when omitted', async () => {
      db.feedbackReport.create.mockResolvedValue(stubReport());

      await service.submit('user-1', makeDto({ context: undefined }));

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ context: FeedbackContext.Unknown }),
        }),
      );
    });

    it('marks redactionApplied=true when the client redacted fields', async () => {
      db.feedbackReport.create.mockResolvedValue(stubReport());

      await service.submit('user-1', makeDto({ userRedactedFields: ['email', 'deviceInfo.serial'] }));

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            redactionApplied: true,
            userRedactedFields: ['email', 'deviceInfo.serial'],
          }),
        }),
      );
    });

    it('persists an empty userRedactedFields array when none supplied', async () => {
      db.feedbackReport.create.mockResolvedValue(stubReport());

      await service.submit('user-1', makeDto({ userRedactedFields: undefined }));

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            redactionApplied: false,
            userRedactedFields: [],
          }),
        }),
      );
    });

    it('runs server-side redaction when enabled and flips serverRedacted on mutation', async () => {
      db.feedbackReport.create.mockResolvedValue(stubReport());
      redaction.scrubString.mockReturnValue({ value: 'scrubbed [REDACTED:email] body', mutated: true });

      await service.submit('user-1', makeDto({ message: 'leaked email@x.io body' }));

      expect(redaction.scrubString).toHaveBeenCalledWith('leaked email@x.io body');
      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            message: 'scrubbed [REDACTED:email] body',
            serverRedacted: true,
          }),
        }),
      );
    });

    it('skips server-side redaction when SystemSetting disables it', async () => {
      db.feedbackReport.create.mockResolvedValue(stubReport());
      db.systemSetting.findFirst.mockResolvedValue(stubSettings({ feedbackReportServerRedactionEnabled: false }));

      await service.submit('user-1', makeDto({ message: 'leaked email@x.io body' }));

      expect(redaction.scrubString).not.toHaveBeenCalled();
      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ serverRedacted: false }),
        }),
      );
    });

    it('emits FeedbackReportSubmitted after a successful create', async () => {
      const created = stubReport({ id: 'fb-emit-1', userId: 'user-7' });
      db.feedbackReport.create.mockResolvedValue(created);

      await service.submit('user-7', makeDto());

      expect(events.emit).toHaveBeenCalledWith(
        FeedbackEvents.FeedbackReportSubmitted,
        expect.objectContaining({
          feedbackReportId: 'fb-emit-1',
          submittedById: 'user-7',
          category: FeedbackCategory.Bug,
          severity: FeedbackSeverity.High,
          context: FeedbackContext.Unknown,
        } satisfies FeedbackReportSubmittedEvent),
      );
    });

    it('does not emit when the create fails', async () => {
      db.feedbackReport.create.mockRejectedValue(new Error('DB connection lost'));

      await expect(service.submit('user-1', makeDto())).rejects.toThrow('DB connection lost');
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('submit idempotency (#251)', () => {
    /**
     * A P2002 in the shape Prisma actually raises, via `@bge/database`'s shared
     * factory. `target` is OPTIONAL and absent by default: omitting it reproduces
     * what `@prisma/client@7.8.0` + `@prisma/adapter-pg` reports, and every case in
     * this block used to pass one — which is why the shape-sniffing discriminator
     * this replaced was never once tested against reality.
     *
     * Fabricated centrally rather than here (#298). Four specs previously invented
     * their own payload, so each discriminator was only ever tested against the
     * mock that fed it, and no single place could be compared against a real
     * database. `apps/api-e2e/src/database/p2002-shape.spec.ts` is what keeps the
     * shared factory honest.
     */
    const uniqueViolation = (target?: string | string[]) =>
      target === undefined ? uniqueViolationWithoutMeta() : sharedUniqueViolation({ target });

    it('persists the client-supplied key on the row', async () => {
      db.feedbackReport.create.mockResolvedValue(stubReport());

      await service.submit('user-1', makeDto({ clientRequestId: 'retry-abc' }));

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ clientRequestId: 'retry-abc' }),
        }),
      );
    });

    it('replays: returns the ORIGINAL report on a key conflict instead of surfacing it', async () => {
      const original = stubReport({ id: 'fb-original', userId: 'user-1', clientRequestId: 'key-1' });
      db.feedbackReport.create.mockRejectedValue(uniqueViolation(FEEDBACK_CLIENT_REQUEST_ID_CONSTRAINT));
      db.feedbackReport.findUnique.mockResolvedValue(original);

      await expect(service.submit('user-1', makeDto({ clientRequestId: 'key-1' }))).resolves.toBe(original);

      expect(db.feedbackReport.findUnique).toHaveBeenCalledWith({
        where: { userId_clientRequestId: { userId: 'user-1', clientRequestId: 'key-1' } },
      });
    });

    it('does NOT re-emit FeedbackReportSubmitted on a replay', async () => {
      db.feedbackReport.create.mockRejectedValue(uniqueViolation(FEEDBACK_CLIENT_REQUEST_ID_CONSTRAINT));
      db.feedbackReport.findUnique.mockResolvedValue(stubReport({ id: 'fb-original' }));

      await service.submit('user-1', makeDto({ clientRequestId: 'key-1' }));

      // The load-bearing assertion of this issue. A second emission would fan
      // out to every sink again: the dispatcher's deterministic jobId only
      // dedups while a job is still queued, so once the original delivery has
      // drained, a re-emit re-delivers and re-calls each driver's submit().
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('still emits on a fresh keyed submission (the suppression is replay-only)', async () => {
      const created = stubReport({ id: 'fb-fresh', userId: 'user-9', clientRequestId: 'key-1' });
      db.feedbackReport.create.mockResolvedValue(created);

      await service.submit('user-9', makeDto({ clientRequestId: 'key-1' }));

      expect(events.emit).toHaveBeenCalledWith(
        FeedbackEvents.FeedbackReportSubmitted,
        expect.objectContaining({ feedbackReportId: 'fb-fresh', submittedById: 'user-9' }),
      );
    });

    it('replays when the P2002 carries NO meta at all', async () => {
      // THE REGRESSION TEST. This is what Prisma 7 + PrismaPg actually raises,
      // and what the previous `meta.target` discriminator could never match: it
      // rethrew, reinstating the 500-then-retry-forever loop #251 was built to
      // remove. Found via the household equivalent's e2e coverage (#257); an
      // e2e proof for this path is #262.
      const original = stubReport({ id: 'fb-original' });
      db.feedbackReport.create.mockRejectedValue(uniqueViolation());
      db.feedbackReport.findUnique.mockResolvedValue(original);

      await expect(service.submit('user-1', makeDto({ clientRequestId: 'key-1' }))).resolves.toBe(original);
    });

    it.each([
      ['the mapped index name', FEEDBACK_CLIENT_REQUEST_ID_CONSTRAINT],
      ['the Prisma field-name array', ['userId', 'clientRequestId']],
      ['the raw column names', ['user_id', 'client_request_id']],
      ['an unrecognized string', 'some_future_prisma_spelling'],
    ])('replays regardless of the reported target shape: %s', async (_label, target) => {
      // Recovery keys off the ROW, not the error shape, so none of these are
      // special-cased any more. Kept as a set because the shape is exactly what
      // drifts across Prisma versions, and the point is that drift no longer
      // changes the outcome.
      const original = stubReport({ id: 'fb-original' });
      db.feedbackReport.create.mockRejectedValue(uniqueViolation(target));
      db.feedbackReport.findUnique.mockResolvedValue(original);

      await expect(service.submit('user-1', makeDto({ clientRequestId: 'key-1' }))).resolves.toBe(original);
    });

    it('rethrows a P2002 from a different unique, because no row exists under the key', async () => {
      // Declined by the LOOKUP now rather than by inspecting the error: no row
      // under this key means nothing committed, so there is no replay to serve.
      // `feedback_reports` has only the one unique besides its primary key, so
      // this branch should be unreachable in practice -- the service warns when
      // it is taken.
      const error = uniqueViolation(['sinkSlug', 'externalId']);
      db.feedbackReport.create.mockRejectedValue(error);
      db.feedbackReport.findUnique.mockResolvedValue(null);

      await expect(service.submit('user-1', makeDto({ clientRequestId: 'key-1' }))).rejects.toBe(error);
      expect(db.feedbackReport.findUnique).toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('rethrows a matching P2002 when no key was supplied (keyless submissions never replay)', async () => {
      const error = uniqueViolation(FEEDBACK_CLIENT_REQUEST_ID_CONSTRAINT);
      db.feedbackReport.create.mockRejectedValue(error);

      await expect(service.submit('user-1', makeDto())).rejects.toBe(error);
      expect(db.feedbackReport.findUnique).not.toHaveBeenCalled();
    });

    it('rethrows the original error when the replay lookup finds nothing', async () => {
      const error = uniqueViolation(FEEDBACK_CLIENT_REQUEST_ID_CONSTRAINT);
      db.feedbackReport.create.mockRejectedValue(error);
      db.feedbackReport.findUnique.mockResolvedValue(null);

      await expect(service.submit('user-1', makeDto({ clientRequestId: 'key-1' }))).rejects.toBe(error);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('rethrows non-unique-constraint failures untouched', async () => {
      const error = new Error('connection reset');
      db.feedbackReport.create.mockRejectedValue(error);

      await expect(service.submit('user-1', makeDto({ clientRequestId: 'key-1' }))).rejects.toBe(error);
      expect(db.feedbackReport.findUnique).not.toHaveBeenCalled();
    });

    it.each([
      ['an empty string', ''],
      ['whitespace only', '   '],
    ])('treats %s as no key (in-process callers skip DTO validation)', async (_label, key) => {
      db.feedbackReport.create.mockResolvedValue(stubReport());

      await service.submit('user-1', makeDto({ clientRequestId: key }));

      // Persisting '' would put every blank-key submission by this user into one
      // shared bucket, silently replaying unrelated reports.
      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ clientRequestId: undefined }) }),
      );
    });

    it('never replays a blank key, even on an idempotency-unique conflict', async () => {
      const error = uniqueViolation(FEEDBACK_CLIENT_REQUEST_ID_CONSTRAINT);
      db.feedbackReport.create.mockRejectedValue(error);

      await expect(service.submit('user-1', makeDto({ clientRequestId: '' }))).rejects.toBe(error);
      expect(db.feedbackReport.findUnique).not.toHaveBeenCalled();
    });

    it('trims a padded key so the DTO and in-process paths share one bucket', async () => {
      const original = stubReport({ id: 'fb-original' });
      db.feedbackReport.create.mockRejectedValue(uniqueViolation(FEEDBACK_CLIENT_REQUEST_ID_CONSTRAINT));
      db.feedbackReport.findUnique.mockResolvedValue(original);

      await expect(service.submit('user-1', makeDto({ clientRequestId: '  key-1  ' }))).resolves.toBe(original);

      expect(db.feedbackReport.findUnique).toHaveBeenCalledWith({
        where: { userId_clientRequestId: { userId: 'user-1', clientRequestId: 'key-1' } },
      });
    });

    it('persists the trimmed key on a fresh keyed submission', async () => {
      db.feedbackReport.create.mockResolvedValue(stubReport());

      await service.submit('user-1', makeDto({ clientRequestId: '  key-1  ' }));

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ clientRequestId: 'key-1' }) }),
      );
    });
  });

  describe('purgeExpired', () => {
    it('hard-deletes reports older than the SystemSetting retention window', async () => {
      db.systemSetting.findFirst.mockResolvedValue(stubSettings({ feedbackReportRetentionDays: 90 }));
      db.feedbackReport.deleteMany.mockResolvedValue({ count: 3 });

      const now = new Date('2026-05-30T12:00:00.000Z');
      const expectedCutoff = DateTime.fromJSDate(now).minus({ days: 90 }).toJSDate();

      const purged = await service.purgeExpired(now);

      expect(db.feedbackReport.deleteMany).toHaveBeenCalledWith({
        where: { createdAt: { lt: expectedCutoff } },
      });
      expect(purged).toBe(3);
    });

    it('honours an overridden retention window from SystemSetting', async () => {
      db.systemSetting.findFirst.mockResolvedValue(stubSettings({ feedbackReportRetentionDays: 30 }));
      db.feedbackReport.deleteMany.mockResolvedValue({ count: 0 });

      const now = new Date('2026-05-30T00:00:00.000Z');
      const expectedCutoff = DateTime.fromJSDate(now).minus({ days: 30 }).toJSDate();

      await service.purgeExpired(now);

      expect(db.feedbackReport.deleteMany).toHaveBeenCalledWith({
        where: { createdAt: { lt: expectedCutoff } },
      });
    });

    it('emits FeedbackReportPurged when reports were deleted', async () => {
      db.feedbackReport.deleteMany.mockResolvedValue({ count: 5 });

      await service.purgeExpired(new Date('2026-05-30T12:00:00.000Z'));

      expect(events.emit).toHaveBeenCalledWith(
        FeedbackEvents.FeedbackReportPurged,
        expect.objectContaining({ purgedCount: 5 } satisfies Partial<FeedbackReportPurgedEvent>),
      );
    });

    it('does NOT emit when the sweep deletes zero reports', async () => {
      db.feedbackReport.deleteMany.mockResolvedValue({ count: 0 });

      await service.purgeExpired(new Date());

      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('banUser', () => {
    it('upserts a UserPermission row inverting create:feedback_report', async () => {
      db.user.findUnique.mockResolvedValue({ id: 'user-9' } as User);
      db.userPermission.upsert.mockResolvedValue({} as unknown as never);

      await service.banUser('user-9', 'admin-1', 'Repeated spam');

      expect(db.permission.findUnique).toHaveBeenCalledWith({
        where: { slug: FEEDBACK_CREATE_PERMISSION_SLUG },
        select: { id: true },
      });

      expect(db.userPermission.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            userId_permissionId_resourceType_resourceId: expect.objectContaining({
              userId: 'user-9',
              permissionId: CREATE_PERMISSION_ID,
            }),
          }),
          create: expect.objectContaining({
            userId: 'user-9',
            permissionId: CREATE_PERMISSION_ID,
            resourceType: ResourceType.FeedbackReport,
            inverted: true,
            grantedById: 'admin-1',
            expiresAt: null,
          }),
          update: expect.objectContaining({
            inverted: true,
            grantedById: 'admin-1',
            expiresAt: null,
          }),
        }),
      );
    });

    it('emits UserFeedbackBanned with reason and (null) expiry', async () => {
      db.user.findUnique.mockResolvedValue({ id: 'user-9' } as User);
      db.userPermission.upsert.mockResolvedValue({} as unknown as never);

      await service.banUser('user-9', 'admin-1', 'Repeated spam');

      expect(events.emit).toHaveBeenCalledWith(
        FeedbackEvents.UserFeedbackBanned,
        expect.objectContaining({
          userId: 'user-9',
          bannedById: 'admin-1',
          reason: 'Repeated spam',
          expiresAt: null,
        } satisfies UserFeedbackBannedEvent),
      );
    });

    it('supports temporary bans via expiresAt', async () => {
      db.user.findUnique.mockResolvedValue({ id: 'user-9' } as User);
      db.userPermission.upsert.mockResolvedValue({} as unknown as never);
      const expiresAt = new Date('2026-07-01T00:00:00.000Z');

      await service.banUser('user-9', 'admin-1', null, expiresAt);

      expect(db.userPermission.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ expiresAt }),
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        FeedbackEvents.UserFeedbackBanned,
        expect.objectContaining({ expiresAt } satisfies Partial<UserFeedbackBannedEvent>),
      );
    });

    it('rejects banning an unknown user with NotFoundException', async () => {
      db.user.findUnique.mockResolvedValue(null);

      await expect(service.banUser('ghost', 'admin-1', null)).rejects.toBeInstanceOf(NotFoundException);
      expect(db.userPermission.upsert).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('raises a clear error when the feedback create permission is missing from the seed', async () => {
      db.user.findUnique.mockResolvedValue({ id: 'user-9' } as User);
      db.permission.findUnique.mockResolvedValue(null);

      await expect(service.banUser('user-9', 'admin-1', null)).rejects.toThrow(/create:feedback_report.*not found/);
      expect(db.userPermission.upsert).not.toHaveBeenCalled();
    });
  });

  describe('unbanUser', () => {
    it('deletes the inverted UserPermission row(s) for create:feedback_report', async () => {
      db.userPermission.deleteMany.mockResolvedValue({ count: 1 });

      await service.unbanUser('user-9', 'admin-1');

      expect(db.userPermission.deleteMany).toHaveBeenCalledWith({
        where: {
          userId: 'user-9',
          permissionId: CREATE_PERMISSION_ID,
          resourceType: ResourceType.FeedbackReport,
          inverted: true,
        },
      });
    });

    it('emits UserFeedbackUnbanned', async () => {
      db.userPermission.deleteMany.mockResolvedValue({ count: 1 });

      await service.unbanUser('user-9', 'admin-1');

      expect(events.emit).toHaveBeenCalledWith(
        FeedbackEvents.UserFeedbackUnbanned,
        expect.objectContaining({
          userId: 'user-9',
          unbannedById: 'admin-1',
        } satisfies UserFeedbackUnbannedEvent),
      );
    });

    it('is idempotent — succeeds when no ban row exists', async () => {
      db.userPermission.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.unbanUser('user-9', 'admin-1')).resolves.toBeUndefined();
      expect(events.emit).toHaveBeenCalledWith(FeedbackEvents.UserFeedbackUnbanned, expect.any(Object));
    });
  });

  describe('stackTrace', () => {
    it('persists stackTrace verbatim when present and unmutated', async () => {
      const stackTrace = 'TypeError: x is not a function\n    at Collection.tsx:42';

      await service.submit('user-1', makeDto({ stackTrace }));

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ stackTrace }),
        }),
      );
    });

    it('persists stackTrace as null when omitted', async () => {
      await service.submit('user-1', makeDto());

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ stackTrace: null }),
        }),
      );
    });

    it('runs stackTrace through scrubString when redaction is enabled', async () => {
      const stackTrace = 'at sendTo(email@x.io)\n    at Foo.bar';

      await service.submit('user-1', makeDto({ stackTrace }));

      expect(redaction.scrubString).toHaveBeenCalledWith(stackTrace);
    });

    it('flips serverRedacted when scrubString mutates the stackTrace', async () => {
      redaction.scrubString.mockImplementation((value: string) =>
        value.includes('email@x.io')
          ? { value: value.replace('email@x.io', '[REDACTED:email]'), mutated: true }
          : { value, mutated: false },
      );

      await service.submit('user-1', makeDto({ message: 'clean message', stackTrace: 'at sendTo(email@x.io)' }));

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            stackTrace: 'at sendTo([REDACTED:email])',
            serverRedacted: true,
          }),
        }),
      );
    });

    it('skips stackTrace redaction when SystemSetting disables it', async () => {
      db.systemSetting.findFirst.mockResolvedValue(stubSettings({ feedbackReportServerRedactionEnabled: false }));
      const stackTrace = 'at sendTo(email@x.io)';

      await service.submit('user-1', makeDto({ stackTrace }));

      expect(redaction.scrubString).not.toHaveBeenCalled();
      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ stackTrace, serverRedacted: false }),
        }),
      );
    });
  });

  describe('breadcrumbs', () => {
    it('passes breadcrumbs through when unmutated (sanitizedContext null-normalized on output)', async () => {
      const breadcrumbs: BreadcrumbDto[] = [makeBreadcrumb(), makeBreadcrumb({ message: 'second' })];

      await service.submit('user-1', makeDto({ breadcrumbs }));

      // The service's scrub pipeline normalizes an omitted sanitizedContext
      // to explicit null on the way out (mirrors the Dart client's nullable
      // wire form, where a missing optional always serializes as null).
      // Other fields pass through verbatim when no mutation is needed.
      const expected = breadcrumbs.map((crumb) => ({ ...crumb, sanitizedContext: null }));

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ breadcrumbs: expected }),
        }),
      );
    });

    it('persists breadcrumbs as Prisma.DbNull when omitted', async () => {
      await service.submit('user-1', makeDto());

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ breadcrumbs: Prisma.DbNull }),
        }),
      );
    });

    it('persists an empty breadcrumbs array as an empty array (not DbNull)', async () => {
      // Distinguishing "client tried but had nothing" from "client omitted"
      // is the contract.
      await service.submit('user-1', makeDto({ breadcrumbs: [] }));

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ breadcrumbs: [] }),
        }),
      );
    });

    it('runs each breadcrumb message through scrubString', async () => {
      const breadcrumbs: BreadcrumbDto[] = [
        makeBreadcrumb({ message: 'crumb one' }),
        makeBreadcrumb({ message: 'crumb two' }),
      ];

      await service.submit('user-1', makeDto({ breadcrumbs }));

      expect(redaction.scrubString).toHaveBeenCalledWith('crumb one');
      expect(redaction.scrubString).toHaveBeenCalledWith('crumb two');
    });

    it('runs each breadcrumb sanitizedContext through scrubObject (null when omitted)', async () => {
      const breadcrumbs: BreadcrumbDto[] = [
        makeBreadcrumb({ sanitizedContext: { gameId: 'g-1' } }),
        makeBreadcrumb({ sanitizedContext: undefined }),
      ];

      await service.submit('user-1', makeDto({ breadcrumbs }));

      expect(redaction.scrubObject).toHaveBeenCalledWith({ gameId: 'g-1' });
      expect(redaction.scrubObject).toHaveBeenCalledWith(null);
    });

    it('flips serverRedacted when any breadcrumb message mutates', async () => {
      redaction.scrubString.mockImplementation((value: string) =>
        value === 'leak: email@x.io' ? { value: 'leak: [REDACTED:email]', mutated: true } : { value, mutated: false },
      );

      await service.submit(
        'user-1',
        makeDto({
          breadcrumbs: [makeBreadcrumb({ message: 'clean' }), makeBreadcrumb({ message: 'leak: email@x.io' })],
        }),
      );

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            serverRedacted: true,
            breadcrumbs: [
              expect.objectContaining({ message: 'clean' }),
              expect.objectContaining({ message: 'leak: [REDACTED:email]' }),
            ],
          }),
        }),
      );
    });

    it('flips serverRedacted when any breadcrumb sanitizedContext mutates', async () => {
      redaction.scrubObject.mockImplementation((value: Record<string, unknown> | null | undefined) => {
        if (value !== null && value !== undefined && 'apiKey' in value) {
          return { value: { ...value, apiKey: '[REDACTED]' }, mutated: true };
        }
        return { value: value ?? null, mutated: false };
      });

      await service.submit(
        'user-1',
        makeDto({
          breadcrumbs: [makeBreadcrumb({ sanitizedContext: { apiKey: 'sk-leak' } })],
        }),
      );

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            serverRedacted: true,
            breadcrumbs: [expect.objectContaining({ sanitizedContext: { apiKey: '[REDACTED]' } })],
          }),
        }),
      );
    });

    it('preserves non-redaction fields (timestamp, level, loggerName) verbatim', async () => {
      const breadcrumbs: BreadcrumbDto[] = [
        makeBreadcrumb({
          timestamp: '2026-06-13T10:00:00.000Z',
          level: BreadcrumbLogLevel.Warn,
          loggerName: 'bge.sync',
          message: 'something happened',
        }),
      ];

      await service.submit('user-1', makeDto({ breadcrumbs }));

      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            breadcrumbs: [
              expect.objectContaining({
                timestamp: '2026-06-13T10:00:00.000Z',
                level: BreadcrumbLogLevel.Warn,
                loggerName: 'bge.sync',
              }),
            ],
          }),
        }),
      );
    });

    it('skips breadcrumb redaction when SystemSetting disables it', async () => {
      db.systemSetting.findFirst.mockResolvedValue(stubSettings({ feedbackReportServerRedactionEnabled: false }));
      const breadcrumbs: BreadcrumbDto[] = [makeBreadcrumb({ message: 'leak: email@x.io' })];

      await service.submit('user-1', makeDto({ breadcrumbs }));

      expect(redaction.scrubString).not.toHaveBeenCalled();
      expect(redaction.scrubObject).not.toHaveBeenCalled();
      expect(db.feedbackReport.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ breadcrumbs, serverRedacted: false }),
        }),
      );
    });
  });
});

function makeDto(overrides: Partial<CreateFeedbackReportDto> = {}): CreateFeedbackReportDto {
  return {
    category: FeedbackCategory.Bug,
    message: 'Crash on add-to-collection',
    severity: FeedbackSeverity.High,
    ...overrides,
  } as CreateFeedbackReportDto;
}

function stubReport(overrides: Partial<FeedbackReport> = {}): FeedbackReport {
  const now = new Date();

  return {
    id: 'fb-1',
    message: 'Crash on add-to-collection',
    stackTrace: null,
    title: null,
    category: FeedbackCategory.Bug,
    context: FeedbackContext.Unknown,
    severity: FeedbackSeverity.High,
    appVersion: null,
    platform: null,
    locale: null,
    deviceInfo: null,
    breadcrumbs: null,
    deploymentRuntime: DeploymentRuntime.Kubernetes,
    deploymentVersion: '0.4.1',
    userId: 'user-1',
    clientRequestId: null,
    userRedactedFields: [],
    redactionApplied: false,
    serverRedacted: false,
    status: FeedbackStatus.New,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  } as FeedbackReport;
}

function stubSettings(overrides: Partial<SystemSetting> = {}): SystemSetting {
  return {
    id: 'settings-1',
    singleton: true,
    identifier: 'default',
    allowPasswordResets: true,
    allowUserRegistration: true,
    allowUsernameChange: true,
    feedbackReportRetentionDays: 90,
    feedbackReportServerRedactionEnabled: true,
    ...overrides,
  } as SystemSetting;
}

function makeBreadcrumb(overrides: Partial<BreadcrumbDto> = {}): BreadcrumbDto {
  return {
    timestamp: '2026-06-13T10:00:00.000Z',
    level: BreadcrumbLogLevel.Info,
    loggerName: 'bge.storage.sync_queue',
    message: 'queued draft report 1f3a',
    ...overrides,
  } as BreadcrumbDto;
}
