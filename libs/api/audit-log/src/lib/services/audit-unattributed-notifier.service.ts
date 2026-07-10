import type { EventSource } from '@bge/actor-context';
import { DatabaseService, NotificationType, SystemRole } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Raises an admin-facing notification when an auditable event was persisted
 * under the unattributed fallback actor — evidence of an entry point missing
 * its actor populator.
 *
 * Dedupe is DB-backed only, keyed on the event name (the thing that
 * identifies the buggy code path): while an unread `AuditUnattributedEvent`
 * notification carrying the same eventName exists — for any admin, in any
 * process — the event is not re-raised. Once admins mark it read, a
 * recurrence raises a fresh one. Deliberately NO in-process memo:
 * unattributed events are bugs and therefore rare, so the indexed lookup per
 * occurrence is cheap, whereas a memo would outlive both transient DB
 * failures and read notifications, permanently muting the alert until the
 * process restarts.
 *
 * Failures are swallowed and logged: the audit row is already persisted, and
 * notification trouble must never surface into the emitting operation.
 */
@Injectable()
export class AuditUnattributedNotifierService {
  private readonly logger = new Logger(AuditUnattributedNotifierService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  async notify(eventName: string, subject: string, source: EventSource | null): Promise<void> {
    try {
      const admins = await this.db.user.findMany({
        where: { roles: { some: { role: { name: { in: [SystemRole.Owner, SystemRole.Admin] } } } } },
        select: { id: true },
      });

      if (admins.length === 0) {
        this.logger.warn(`No admin users to notify about unattributed audit event "${eventName}"`);
        return;
      }

      // Scoped to the admin ids so the query enters through the leading
      // column of the (userId, read, createdAt) index instead of scanning the
      // whole notifications table for the JSON payload match.
      const alreadyPending = await this.db.notification.findFirst({
        where: {
          userId: { in: admins.map((admin) => admin.id) },
          read: false,
          type: NotificationType.AuditUnattributedEvent,
          payload: { path: ['eventName'], equals: eventName },
        },
        select: { id: true },
      });

      if (alreadyPending) {
        return;
      }

      await this.notifications.createMany(
        admins.map((admin) => ({
          userId: admin.id,
          type: NotificationType.AuditUnattributedEvent,
          payload: { eventName, subject, source },
        })),
      );

      this.logger.warn(
        `Auditable event "${eventName}" (subject ${subject}) had no CLS actor scope; notified ${admins.length} admin(s)`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to raise unattributed-event notification for "${eventName}": ${
          err instanceof Error ? err.message : err
        }`,
      );
    }
  }
}
