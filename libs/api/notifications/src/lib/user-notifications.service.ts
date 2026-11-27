import { Action, DatabaseService, ResourceType } from '@bge/database';
import type { NotificationDto, NotificationPayload, UnreadNotificationDto } from '@bge/notifications-service';
import { AbilityService, ScopeComposer } from '@bge/permissions';
import type { CursorPage, KeysetPosition } from '@bge/shared';
import { cursorPage, olderThan } from '@bge/shared';
import { Injectable, Logger } from '@nestjs/common';
import { MAX_UNREAD_NOTIFICATIONS } from './notifications.constants';

/**
 * One user's own notifications: the history and unread lists, the unread
 * count, and marking them read.
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
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the (type, payload) pairing create() writes is a correlation a JSON column can't carry (#1321)
    return notifications.map((notification) => ({
      id: notification.id,
      type: notification.type,
      read: notification.read,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Prisma types the column as JsonValue, which shares no shape with the payload interfaces, so the cast goes through unknown (#1321)
      payload: notification.payload as unknown as NotificationPayload,
      createdAt: notification.createdAt,
    })) as UnreadNotificationDto[];
  }

  /**
   * One page of the user's notification history, read and unread alike,
   * newest first. The scope is the user's own notifications and the caller's
   * ceiling clips it, as on `/unread`.
   *
   * Paged by keyset, not offset: a notification written while a client pages
   * would shift an offset page and repeat a row. The cursor clause goes inside
   * the scope's `AND`, so the composer sets it beside the ceiling; it narrows
   * the set and never stands in for the ceiling. The order ends on `id` to
   * match `olderThan`'s tie-break, which keeps a page boundary inside a
   * `createMany` batch, whose rows share one `createdAt`, from skipping or
   * repeating a row. One row past the page tells `cursorPage` whether another
   * page exists (#1597).
   */
  async list(
    userId: string,
    { after, pageSize }: { after?: KeysetPosition; pageSize: number },
  ): Promise<CursorPage<NotificationDto>> {
    const notifications = await this.db.notification.findMany({
      where: this.scopeComposer.compose(ResourceType.Notification, Action.read, {
        userId,
        ...(after && { AND: [olderThan(after)] }),
      }),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pageSize + 1,
      select: { id: true, type: true, read: true, readAt: true, payload: true, createdAt: true },
    });

    this.logger.debug(`Found ${notifications.length} notifications for user ${userId}`);

    // The same assertion as getUnread's: create() writes (type, payload)
    // together, but a JSON column can't carry that correlation to the compiler.
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the (type, payload) pairing create() writes is a correlation a JSON column can't carry (#1321)
    const rows = notifications.map((notification) => ({
      id: notification.id,
      type: notification.type,
      read: notification.read,
      readAt: notification.readAt,
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Prisma types the column as JsonValue, which shares no shape with the payload interfaces, so the cast goes through unknown (#1321)
      payload: notification.payload as unknown as NotificationPayload,
      createdAt: notification.createdAt,
    })) as NotificationDto[];

    return cursorPage(rows, pageSize);
  }

  /**
   * How many unread notifications the user has, within the caller's `read`
   * ceiling, as the lists compose it. Uncapped, unlike `/unread`'s list, so a
   * badge can show the real number (#1597).
   */
  async countUnread(userId: string): Promise<number> {
    return this.db.notification.count({
      where: this.scopeComposer.compose(ResourceType.Notification, Action.read, { userId, read: false }),
    });
  }

  /**
   * Marks the named unread notifications read, of those that are the user's
   * own and that the caller may update. Both writes AND the caller's `update` ceiling
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
        // As markAllRead: one already read keeps the readAt it has (#903).
        read: false,
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
