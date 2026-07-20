import type { FeedbackReport, SystemSetting } from '@bge/database';
import { DatabaseService, Prisma, ResourceType } from '@bge/database';
import { t } from '@bge/i18n';
import { DeploymentInfoService } from '@bge/services';
import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DateTime } from 'luxon';
import { FeedbackEvents } from './constants/feedback-events.constant';
import { FEEDBACK_CREATE_PERMISSION_SLUG } from './constants/feedback.constants';
import type { BreadcrumbDto } from './dto/breadcrumb.dto';
import type { CreateFeedbackReportDto } from './dto/create-feedback-report.dto';
import type {
  FeedbackReportPurgedEvent,
  FeedbackReportSubmittedEvent,
  UserFeedbackBannedEvent,
  UserFeedbackUnbannedEvent,
} from './interfaces/feedback.interface';
import { RedactionService } from './services/redaction.service';

interface RedactionOutcome {
  readonly redactedMessage: string;
  readonly redactedStackTrace: string | null;
  readonly redactedDeviceInfo: Record<string, unknown> | null;
  readonly redactedBreadcrumbs: BreadcrumbDto[] | null;
  readonly serverRedacted: boolean;
}

interface BreadcrumbsScrubResult {
  readonly value: BreadcrumbDto[] | null;
  readonly mutated: boolean;
}

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
   *
   * All user-supplied free-text fields (message, stackTrace) and structured
   * payloads (deviceInfo, breadcrumbs[].message, breadcrumbs[].sanitizedContext)
   * pass through `RedactionService` when `feedbackReportServerRedactionEnabled`
   * is on. The first-party client already sanitizes breadcrumbs at capture, but
   * third-party clients can't be trusted to do so — re-running redaction here
   * is cheap and idempotent, and `serverRedacted` flips to expose mismatches
   * for operational telemetry.
   */
  async submit(userId: string, dto: CreateFeedbackReportDto): Promise<FeedbackReport> {
    const settings = await this.getSettings();
    const { redactedMessage, redactedStackTrace, redactedDeviceInfo, redactedBreadcrumbs, serverRedacted } =
      this.redactIfEnabled(dto, settings);

    const { runtime, version } = this.deploymentInfo.getInfo();
    const userRedactedFields = dto.userRedactedFields ?? [];

    const created = await this.db.feedbackReport.create({
      data: {
        message: redactedMessage,
        stackTrace: redactedStackTrace,
        title: dto.title ?? null,
        category: dto.category,
        context: dto.context ?? 'Unknown',
        severity: dto.severity ?? null,
        appVersion: dto.appVersion ?? null,
        platform: dto.platform ?? null,
        locale: dto.locale ?? null,
        deviceInfo: redactedDeviceInfo !== null ? (redactedDeviceInfo as Prisma.InputJsonValue) : Prisma.DbNull,
        breadcrumbs:
          redactedBreadcrumbs !== null ? (redactedBreadcrumbs as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
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
      throw new NotFoundException(t('errors.user.not_found', { id: userId }));
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

  private redactIfEnabled(dto: CreateFeedbackReportDto, settings: SystemSetting): RedactionOutcome {
    if (settings.feedbackReportServerRedactionEnabled === false) {
      return {
        redactedMessage: dto.message,
        redactedStackTrace: dto.stackTrace ?? null,
        redactedDeviceInfo: dto.deviceInfo ?? null,
        redactedBreadcrumbs: dto.breadcrumbs ?? null,
        serverRedacted: false,
      };
    }

    const messageResult = this.redaction.scrubString(dto.message);
    const stackTraceResult = dto.stackTrace ? this.redaction.scrubString(dto.stackTrace) : null;
    const deviceInfoResult = this.redaction.scrubObject(dto.deviceInfo ?? null);
    const breadcrumbsResult = this.scrubBreadcrumbs(dto.breadcrumbs);

    return {
      redactedMessage: messageResult.value,
      redactedStackTrace: stackTraceResult?.value ?? null,
      redactedDeviceInfo: deviceInfoResult.value,
      redactedBreadcrumbs: breadcrumbsResult.value,
      serverRedacted:
        messageResult.mutated ||
        (stackTraceResult?.mutated ?? false) ||
        deviceInfoResult.mutated ||
        breadcrumbsResult.mutated,
    };
  }

  /**
   * Re-runs the message + sanitizedContext redaction pipeline over each
   * breadcrumb. Idempotent on already-sanitized input (the first-party
   * client scrubs at capture; this is the third-party defense). Preserves
   * non-redaction fields (timestamp, level, loggerName) verbatim.
   *
   * Returns `value: null` when the caller omitted breadcrumbs entirely;
   * an empty array round-trips as `value: []` to keep "explicit empty" and
   * "absent" distinguishable downstream.
   */
  private scrubBreadcrumbs(breadcrumbs: BreadcrumbDto[] | undefined): BreadcrumbsScrubResult {
    if (!breadcrumbs) {
      return { value: null, mutated: false };
    }

    let mutated = false;
    const scrubbed: BreadcrumbDto[] = breadcrumbs.map((crumb): BreadcrumbDto => {
      const messageResult = this.redaction.scrubString(crumb.message);
      const contextResult = this.redaction.scrubObject(crumb.sanitizedContext ?? null);

      if (messageResult.mutated || contextResult.mutated) {
        mutated = true;
      }

      return {
        ...crumb,
        message: messageResult.value,
        sanitizedContext: contextResult.value,
      };
    });

    return { value: scrubbed, mutated };
  }

  private async getSettings(): Promise<SystemSetting> {
    const settings = await this.db.systemSetting.findFirst();

    if (settings === null) {
      throw new Error('SystemSetting singleton not seeded');
    }

    return settings;
  }
}
