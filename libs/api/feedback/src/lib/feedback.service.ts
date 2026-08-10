import type { FeedbackReport, SystemSetting } from '@bge/database';
import { DatabaseService, isPrismaUniqueConstraintError, Prisma, ResourceType } from '@bge/database';
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
   *
   * When `dto.clientRequestId` is present the submission is idempotent: a repeat
   * with the same key returns the original report rather than inserting a second
   * one, and skips event emission so sinks are not re-notified (#251). The
   * repeat's payload is ignored — first writer wins. Redaction still runs on the
   * replay path and its result is discarded; keeping one code path is worth more
   * than the saved work, and a pre-flight key lookup would cost a read on every
   * keyed submission while still racing.
   */
  async submit(userId: string, dto: CreateFeedbackReportDto): Promise<FeedbackReport> {
    const settings = await this.getSettings();
    const { redactedMessage, redactedStackTrace, redactedDeviceInfo, redactedBreadcrumbs, serverRedacted } =
      this.redactIfEnabled(dto, settings);

    const { runtime, version } = this.deploymentInfo.getInfo();
    const userRedactedFields = dto.userRedactedFields ?? [];

    // A blank key is not a key. The DTO rejects one over HTTP, but `submit` is
    // also callable in-process, and persisting '' would put every blank-key
    // submission by a user into one shared idempotency bucket — the second would
    // silently "replay" the first and return an unrelated report. Trim so both
    // entry points agree on the bucket: the DTO trims too, so a padded retry
    // can't split into two rows.
    const clientRequestId = dto.clientRequestId?.trim() || undefined;

    let created: FeedbackReport;
    try {
      // Optimistic insert — no pre-flight key lookup. A concurrent duplicate
      // submission races here; the loser trips the composite unique and is
      // recovered in the catch below.
      created = await this.db.feedbackReport.create({
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
          clientRequestId,
          userRedactedFields,
          redactionApplied: userRedactedFields.length > 0,
          serverRedacted,
          user: { connect: { id: userId } },
        },
      });
    } catch (error) {
      const replayed =
        clientRequestId === undefined ? null : await this.recoverKeyedSubmit(error, userId, clientRequestId);

      if (!replayed) {
        throw error;
      }

      // Deliberately returns WITHOUT emitting. A replay must not re-trigger sink
      // fan-out: `FeedbackDispatcherService`'s deterministic jobId only dedups
      // while a job is still queued (`removeOnComplete` frees the id on success),
      // so a second emission after a successful drain would re-deliver the report
      // to every sink and re-call each driver's `submit()`.
      //
      // Known residual: if the original committed but its fan-out never happened
      // (the process died before the listener ran, or every enqueue failed — which
      // the dispatcher logs and drops), the replay acknowledges a report that no
      // sink will ever receive, and the client stops retrying. Not healed here on
      // purpose: emitting conditionally would couple this service to
      // `FeedbackSubmission` state and would still only rescue the reports a
      // client happens to resubmit. A reconciliation sweep over reports with no
      // submission rows covers that whole class, including the ones never
      // retried, and is the right home for it.
      return replayed;
    }

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
   * Recovers an idempotent replay from a failed keyed insert: returns the
   * original report when a unique violation is accompanied by a row under this
   * key, or `null` to mean "not a replay — rethrow".
   *
   * THE ROW DECIDES, NOT THE ERROR SHAPE. This previously discriminated on
   * `meta.target`, accepting three spellings because Prisma has reported
   * different ones across provider/version combinations. Under Prisma 7 with
   * the `PrismaPg` driver adapter it reports NONE of them — `meta` carries no
   * usable `target` — so the discriminator never matched and every keyed retry
   * rethrew, reinstating exactly the 500-then-retry-forever loop this feature
   * was built to remove. Found via the household equivalent's e2e coverage
   * (#257); the identical defect here has no e2e proof yet, which is #262.
   *
   * Keying off the lookup is both correct and shape-independent: a row under
   * `(userId, clientRequestId)` means this key's insert already committed, which
   * is precisely the condition a replay must return, whatever the database chose
   * to say about which index it was.
   *
   * No `deletedAt` filter to omit here (unlike the household equivalent):
   * `FeedbackReport` has no soft-delete. The retention sweep hard-deletes it, so
   * a key never outlives its report — a retry arriving after the retention window
   * finds nothing and creates a fresh report. Accepted caveat on #251; the
   * retention window vastly exceeds any plausible offline-queue lifetime.
   */
  private async recoverKeyedSubmit(
    error: unknown,
    userId: string,
    clientRequestId: string,
  ): Promise<FeedbackReport | null> {
    if (!isPrismaUniqueConstraintError(error)) {
      return null;
    }

    const existing = await this.db.feedbackReport.findUnique({
      where: { userId_clientRequestId: { userId, clientRequestId } },
    });

    if (!existing) {
      // `feedback_reports` carries exactly one unique index besides the primary
      // key, so a P2002 with no row under this key should not be reachable at
      // all. Warn rather than debug: this is the branch that reinstates the
      // 500-then-retry-forever loop #251 removed, and the whole `meta` is logged
      // because the old discriminator's blind spot was assuming `target` exists.
      this.logger.warn(
        `Keyed feedback submission raised P2002 with no row under the key; ` +
          `meta=${JSON.stringify(error.meta)}. Rethrowing.`,
      );

      return null;
    }

    this.logger.debug(`Idempotent replay of feedback submission for user ${userId}; returning report ${existing.id}`);

    return existing;
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
