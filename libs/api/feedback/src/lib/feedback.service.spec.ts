import type { FeedbackReport, Permission, SystemSetting, User } from '@bge/database';
import {
  DeploymentRuntime,
  FeedbackCategory,
  FeedbackContext,
  FeedbackSeverity,
  FeedbackStatus,
  ResourceType,
} from '@bge/database';
import { DeploymentInfoService } from '@bge/services';
import { createTestingModuleWithDb, MockDatabaseService } from '@bge/testing';
import { NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DateTime } from 'luxon';
import { FeedbackEvents } from './constants/feedback-events.constant';
import { FEEDBACK_CREATE_PERMISSION_SLUG } from './constants/feedback.constants';
import { CreateFeedbackReportDto } from './dto/create-feedback-report.dto';
import { FeedbackService } from './feedback.service';
import type {
  FeedbackReportPurgedEvent,
  FeedbackReportSubmittedEvent,
  UserFeedbackBannedEvent,
  UserFeedbackUnbannedEvent,
} from './interfaces/feedback.interface';
import { RedactionService } from './services/redaction.service';

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

      const createArg = db.feedbackReport.create.mock.calls[0][0] as {
        data: { deploymentRuntime: DeploymentRuntime; deploymentVersion: string | null };
      };
      expect(createArg.data.deploymentRuntime).toBe(DeploymentRuntime.DockerCompose);
      expect(createArg.data.deploymentVersion).toBe('0.5.0');
    });

    it('defaults context to Unknown when omitted', async () => {
      db.feedbackReport.create.mockResolvedValue(stubReport());

      await service.submit('user-1', makeDto({ context: undefined }));

      const createArg = db.feedbackReport.create.mock.calls[0][0] as { data: { context: FeedbackContext } };
      expect(createArg.data.context).toBe(FeedbackContext.Unknown);
    });

    it('marks redactionApplied=true when the client redacted fields', async () => {
      db.feedbackReport.create.mockResolvedValue(stubReport());

      await service.submit('user-1', makeDto({ userRedactedFields: ['email', 'deviceInfo.serial'] }));

      const createArg = db.feedbackReport.create.mock.calls[0][0] as {
        data: { redactionApplied: boolean; userRedactedFields: string[] };
      };
      expect(createArg.data.redactionApplied).toBe(true);
      expect(createArg.data.userRedactedFields).toEqual(['email', 'deviceInfo.serial']);
    });

    it('persists an empty userRedactedFields array when none supplied', async () => {
      db.feedbackReport.create.mockResolvedValue(stubReport());

      await service.submit('user-1', makeDto({ userRedactedFields: undefined }));

      const createArg = db.feedbackReport.create.mock.calls[0][0] as {
        data: { redactionApplied: boolean; userRedactedFields: string[] };
      };
      expect(createArg.data.redactionApplied).toBe(false);
      expect(createArg.data.userRedactedFields).toEqual([]);
    });

    it('runs server-side redaction when enabled and flips serverRedacted on mutation', async () => {
      db.feedbackReport.create.mockResolvedValue(stubReport());
      redaction.scrubString.mockReturnValue({ value: 'scrubbed [REDACTED:email] body', mutated: true });

      await service.submit('user-1', makeDto({ message: 'leaked email@x.io body' }));

      expect(redaction.scrubString).toHaveBeenCalledWith('leaked email@x.io body');
      const createArg = db.feedbackReport.create.mock.calls[0][0] as {
        data: { message: string; serverRedacted: boolean };
      };
      expect(createArg.data.message).toBe('scrubbed [REDACTED:email] body');
      expect(createArg.data.serverRedacted).toBe(true);
    });

    it('skips server-side redaction when SystemSetting disables it', async () => {
      db.feedbackReport.create.mockResolvedValue(stubReport());
      db.systemSetting.findFirst.mockResolvedValue(stubSettings({ feedbackReportServerRedactionEnabled: false }));

      await service.submit('user-1', makeDto({ message: 'leaked email@x.io body' }));

      expect(redaction.scrubString).not.toHaveBeenCalled();
      const createArg = db.feedbackReport.create.mock.calls[0][0] as { data: { serverRedacted: boolean } };
      expect(createArg.data.serverRedacted).toBe(false);
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

    it('persists the correlationKey when supplied', async () => {
      db.feedbackReport.create.mockResolvedValue(stubReport());

      await service.submit('user-1', makeDto({ correlationKey: 'retry-abc' }));

      const createArg = db.feedbackReport.create.mock.calls[0][0] as { data: { correlationKey: string | null } };
      expect(createArg.data.correlationKey).toBe('retry-abc');
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

      const upsertArg = db.userPermission.upsert.mock.calls[0][0] as {
        where: { userId_permissionId_resourceType_resourceId: { userId: string; permissionId: string } };
        create: {
          userId: string;
          permissionId: string;
          inverted: boolean;
          grantedById: string;
          expiresAt: Date | null;
        };
        update: { inverted: boolean; grantedById: string; expiresAt: Date | null };
      };

      expect(upsertArg.where.userId_permissionId_resourceType_resourceId).toMatchObject({
        userId: 'user-9',
        permissionId: CREATE_PERMISSION_ID,
      });
      expect(upsertArg.create).toMatchObject({
        userId: 'user-9',
        permissionId: CREATE_PERMISSION_ID,
        resourceType: ResourceType.FeedbackReport,
        inverted: true,
        grantedById: 'admin-1',
        expiresAt: null,
      });
      expect(upsertArg.update).toMatchObject({
        inverted: true,
        grantedById: 'admin-1',
        expiresAt: null,
      });
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

      const upsertArg = db.userPermission.upsert.mock.calls[0][0] as {
        create: { expiresAt: Date | null };
      };
      expect(upsertArg.create.expiresAt).toBe(expiresAt);
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
    title: null,
    category: FeedbackCategory.Bug,
    context: FeedbackContext.Unknown,
    severity: FeedbackSeverity.High,
    appVersion: null,
    platform: null,
    locale: null,
    deviceInfo: null,
    deploymentRuntime: DeploymentRuntime.Kubernetes,
    deploymentVersion: '0.4.1',
    userId: 'user-1',
    correlationKey: null,
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
