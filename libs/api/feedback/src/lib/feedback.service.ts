import type { FeedbackReport, SystemSetting } from '@bge/database';
import { DatabaseService, Prisma, ResourceType } from '@bge/database';
import { DeploymentInfoService } from '@bge/services';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DateTime } from 'luxon';
import { FeedbackEvents } from './constants/feedback-events.constant';
import { FEEDBACK_CREATE_PERMISSION_SLUG } from './constants/feedback.constants';
import type { CreateFeedbackReportDto } from './dto/create-feedback-report.dto';
import type {
  FeedbackReportPurgedEvent,
  FeedbackReportSubmittedEvent,
  UserFeedbackBannedEvent,
  UserFeedbackUnbannedEvent,
} from './interfaces/feedback.interface';
import { RedactionService } from './services/redaction.service';

/**
 * Feedback feature service.
 *
 * Persistence + domain-event emission live here. *Sink routing* (forwarding
 * to GitHub/Sentry/etc.) is the responsibility of `@OnEvent` listeners —
 * `FeedbackSinkRouter` subscribes to `FeedbackEvents.FeedbackReportSubmitted`
 * once external drivers exist. Same pattern as other domains in the repo.
 *
 * Banning is expressed as a `UserPermission` row inverting `create:feedback_report`
 * for the target user. The controller's `PoliciesGuard` enforces the resulting
 * ability denial — no service-level ban check is needed. This gives us free
 * audit attribution (`UserPermission.grantedById` / `createdAt`), free temporary
 * bans (`expiresAt`), and a uniform pattern with the rest of the permission model.
 */
@Injectable()
export class FeedbackService {
  private readonly logger = new Logger(FeedbackService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly events: EventEmitter2,
    private readonly redaction: RedactionService,
    private readonly deploymentInfo: DeploymentInfoService,
  ) {}

  /**
   * Persist a feedback report. Caller is responsible for ensuring the actor
   * has `create:FeedbackReport` ability — the controller's `PoliciesGuard`
   * enforces this. Banned users are denied at the guard layer because their
   * `UserPermission` inverts the role-derived `create:feedback_report` grant.
   */
  async submit(userId: string, dto: CreateFeedbackReportDto): Promise<FeedbackReport> {
    const settings = await this.getSettings();
    const { redactedMessage, redactedDeviceInfo, serverRedacted } = this.redactIfEnabled(dto, settings);

    const { runtime, version } = this.deploymentInfo.getInfo();
    const userRedactedFields = dto.userRedactedFields ?? [];

    const created = await this.db.feedbackReport.create({
      data: {
        message: redactedMessage,
        title: dto.title ?? null,
        category: dto.category,
        context: dto.context ?? 'Unknown',
        severity: dto.severity ?? null,
        appVersion: dto.appVersion ?? null,
        platform: dto.platform ?? null,
        locale: dto.locale ?? null,
        deviceInfo: redactedDeviceInfo !== null ? (redactedDeviceInfo as Prisma.InputJsonValue) : Prisma.DbNull,
        deploymentRuntime: runtime,
        deploymentVersion: version,
        correlationKey: dto.correlationKey ?? null,
        userRedactedFields,
        redactionApplied: userRedactedFields.length > 0,
        serverRedacted,
        user: { connect: { id: userId } },
      },
    });

    this.events.emit(FeedbackEvents.FeedbackReportSubmitted, {
      feedbackReportId: created.id,
      submittedById: userId,
      category: created.category,
      context: created.context,
      severity: created.severity,
    } satisfies FeedbackReportSubmittedEvent);

    return created;
  }

  /**
   * Hard-delete feedback reports older than the system-configured retention
   * window. Invoked by the scheduled retention worker.
   */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const settings = await this.getSettings();
    const cutoff = DateTime.fromJSDate(now).minus({ days: settings.feedbackReportRetentionDays }).toJSDate();

    const result = await this.db.feedbackReport.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });

    if (result.count > 0) {
      this.logger.log(`Purged ${result.count} feedback reports older than ${cutoff.toISOString()}`);
      this.events.emit(FeedbackEvents.FeedbackReportPurged, {
        purgedCount: result.count,
        olderThan: cutoff,
      } satisfies FeedbackReportPurgedEvent);
    }

    return result.count;
  }

  /**
   * Ban a user from submitting feedback reports.
   *
   * Implemented as a `UserPermission` row that inverts the role-derived
   * `create:feedback_report` permission for this user. The next time the
   * ability factory loads their permissions, the inverted entry takes
   * precedence and `can('create', 'FeedbackReport')` returns false.
   *
   * Idempotent: calling twice with the same args results in one row (upsert).
   * Caller is responsible for asserting authority (admin/moderator); this
   * service treats the call as already-authorized.
   */
  async banUser(
    userId: string,
    bannedById: string,
    reason: string | null,
    expiresAt: Date | null = null,
  ): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { id: true } });

    if (user === null) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    const permission = await this.findCreatePermission();

    await this.db.userPermission.upsert({
      where: {
        userId_permissionId_resourceType_resourceId: {
          userId,
          permissionId: permission.id,
          resourceType: ResourceType.FeedbackReport,
          resourceId: null as unknown as string, // composite-unique allows null
        },
      },
      create: {
        userId,
        permissionId: permission.id,
        resourceType: ResourceType.FeedbackReport,
        resourceId: null,
        inverted: true,
        grantedById: bannedById,
        expiresAt,
      },
      update: {
        inverted: true,
        grantedById: bannedById,
        expiresAt,
      },
    });

    this.events.emit(FeedbackEvents.UserFeedbackBanned, {
      userId,
      bannedById,
      reason,
      expiresAt,
    } satisfies UserFeedbackBannedEvent);
  }

  /**
   * Lift a feedback submission ban. Idempotent — succeeds even if no ban
   * was active.
   */
  async unbanUser(userId: string, unbannedById: string): Promise<void> {
    const permission = await this.findCreatePermission();

    await this.db.userPermission.deleteMany({
      where: {
        userId,
        permissionId: permission.id,
        resourceType: ResourceType.FeedbackReport,
        inverted: true,
      },
    });

    this.events.emit(FeedbackEvents.UserFeedbackUnbanned, {
      userId,
      unbannedById,
    } satisfies UserFeedbackUnbannedEvent);
  }

  private async findCreatePermission(): Promise<{ id: string }> {
    const permission = await this.db.permission.findUnique({
      where: { slug: FEEDBACK_CREATE_PERMISSION_SLUG },
      select: { id: true },
    });

    if (permission === null) {
      throw new Error(
        `Permission '${FEEDBACK_CREATE_PERMISSION_SLUG}' not found — ensure the feedback permissions seed has been applied.`,
      );
    }

    return permission;
  }

  private redactIfEnabled(
    dto: CreateFeedbackReportDto,
    settings: SystemSetting,
  ): { redactedMessage: string; redactedDeviceInfo: Record<string, unknown> | null; serverRedacted: boolean } {
    if (settings.feedbackReportServerRedactionEnabled === false) {
      return {
        redactedMessage: dto.message,
        redactedDeviceInfo: dto.deviceInfo ?? null,
        serverRedacted: false,
      };
    }

    const messageResult = this.redaction.scrubString(dto.message);
    const deviceInfoResult = this.redaction.scrubObject(dto.deviceInfo ?? null);

    return {
      redactedMessage: messageResult.value,
      redactedDeviceInfo: deviceInfoResult.value,
      serverRedacted: messageResult.mutated || deviceInfoResult.mutated,
    };
  }

  private async getSettings(): Promise<SystemSetting> {
    const settings = await this.db.systemSetting.findFirst();

    if (settings === null) {
      throw new Error('SystemSetting singleton not seeded');
    }

    return settings;
  }
}
