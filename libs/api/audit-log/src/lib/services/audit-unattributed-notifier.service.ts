import type { EventSource } from '@bge/actor-context';
import { DatabaseService, NotificationType } from '@bge/database';
import { findServerAdminIds, NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Tells the server admins when an auditable event was persisted under the
 * unattributed fallback actor — evidence of an entry point missing its actor
 * populator.
 *
 * Dedupe is DB-backed only, keyed on the event name (the thing that
 * identifies the buggy code path), and per server admin: one holding an
 * unread `AuditUnattributedEvent` notification carrying the same eventName
 * isn't told again, in any process, and one who has read theirs is, whoever
 * else hasn't. Deliberately NO in-process memo: unattributed events are bugs
 * and therefore rare, so the indexed lookup per occurrence is cheap, whereas
 * a memo would outlive both transient DB failures and read notifications,
 * permanently muting the alert until the process restarts.
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
      const adminIds = await findServerAdminIds(this.db);

      if (adminIds.length === 0) {
        this.logger.warn(`No server admins to notify about unattributed audit event "${eventName}"`);
        return;
      }

      // Scoped to the server admins' ids so the query enters through the
      // leading column of the (userId, read, createdAt) index instead of
      // scanning the whole notifications table for the JSON payload match.
      const pending = await this.db.notification.findMany({
        where: {
          userId: { in: adminIds },
          read: false,
          type: NotificationType.AuditUnattributedEvent,
          payload: { path: ['eventName'], equals: eventName },
        },
        select: { userId: true },
      });
      const alreadyTold = new Set(pending.map((notification) => notification.userId));
      const toTell = adminIds.filter((userId) => !alreadyTold.has(userId));

      if (toTell.length === 0) {
        return;
      }

      await this.notifications.createMany(
        toTell.map((userId) => ({
          userId,
          type: NotificationType.AuditUnattributedEvent,
          payload: { eventName, subject, source },
        })),
      );

      this.logger.warn(
        `Auditable event "${eventName}" (subject ${subject}) had no CLS actor scope; notified ${toTell.length} server admin(s)`,
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
