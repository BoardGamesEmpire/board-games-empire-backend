import { Action, DatabaseService, ResourceType } from '@bge/database';
import type { NotificationPayload, UnreadNotificationDto } from '@bge/notifications-service';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import { Injectable, Logger } from '@nestjs/common';

/**
 * Upper bound on rows returned by {@link UserNotificationsService.getUnread}.
 * The endpoint is unpaginated and polled, and there is no unread-pruning, so a
 * dormant account can accumulate thousands of unread rows; without a cap every
 * poll would fetch all of them. 100 most-recent is plenty for a notification
 * tray.
 */
const MAX_UNREAD_NOTIFICATIONS = 100;

/**
 * One user's own notifications: the unread list and marking them read.
 *
 * These live at the API edge rather than beside `create` and `createMany` in
 * `@bge/notifications-service`, because they compose the caller's ceiling and
 * that needs the permissions lib. The service the workers use to write
 * notifications takes no such dependency, and none of its callers would use it
 * (#517).
 */
@Injectable()
export class UserNotificationsService {
  private readonly logger = new Logger(UserNotificationsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly abilityService: AbilityService,
    private readonly scopeComposer: ScopeComposer,
  ) {}

  /**
   * The user's unread notifications, newest first. The scope is the user's
   * own unread ones, and the caller's ceiling only clips it: an API key scoped
   * to one notification lists that one alone. A bare array, not a page: the
   * list is polled and capped instead.
   */
  async getUnread(userId: string): Promise<UnreadNotificationDto[]> {
    const notifications = await this.db.notification.findMany({
      where: this.scopeComposer.compose(ResourceType.Notification, Action.read, { userId, read: false }),
      orderBy: { createdAt: 'desc' },
      take: MAX_UNREAD_NOTIFICATIONS,
      select: { id: true, type: true, read: true, payload: true, createdAt: true },
    });

    this.logger.debug(`Found ${notifications.length} unread notifications for user ${userId}`);

    // The (type, payload) pairing is written together by `create()`, so it is
    // sound — but the compiler can't prove the correlation from a JSON column,
    // so assert the discriminated-union shape once here.
    return notifications.map((notification) => ({
      id: notification.id,
      type: notification.type,
      read: notification.read,
      payload: notification.payload as unknown as NotificationPayload,
      createdAt: notification.createdAt,
    })) as UnreadNotificationDto[];
  }

  /**
   * Marks the named notifications read, of those that are the user's own and
   * that the caller may update. Both writes AND the caller's `update` ceiling
   * into their filter, as a read composes its own: without it an API key
   * scoped to one notification marked every notification of its owner's
   * (#649). An id outside the ceiling is skipped, not refused, as an id that
   * is not the user's is.
   */
  async markRead(userId: string, notificationIds: string[]): Promise<void> {
    this.logger.debug(`Marking ${notificationIds.length} notifications as read for user ${userId}`);
    await this.db.notification.updateMany({
      where: {
        id: { in: notificationIds },
        userId,
        // eslint-disable-next-line no-restricted-syntax -- a write's filter by the caller's ids, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Notification, Action.update),
      },
      data: { read: true, readAt: new Date() },
    });
  }

  /** Marks every unread notification of the user's read, within the caller's `update` ceiling. */
  async markAllRead(userId: string): Promise<void> {
    this.logger.debug(`Marking all notifications as read for user ${userId}`);
    await this.db.notification.updateMany({
      where: {
        userId,
        read: false,
        // eslint-disable-next-line no-restricted-syntax -- a write's filter, not a collection read
        AND: this.abilityService.getCurrentResourceConditions(ResourceType.Notification, Action.update),
      },
      data: { read: true, readAt: new Date() },
    });
  }
}
