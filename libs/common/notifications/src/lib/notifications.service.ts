import { DatabaseService, NotificationType } from '@bge/database';
import { Injectable, Logger } from '@nestjs/common';
import { InputJsonValue } from '@prisma/client/runtime/client';
import type { CreateNotificationInput, NotificationPayload, UnreadNotificationDto } from './interfaces';

/**
 * Upper bound on rows returned by {@link NotificationsService.getUnread}. The
 * endpoint is unpaginated and polled, and there is no unread-pruning, so a
 * dormant account can accumulate thousands of unread rows; without a cap every
 * poll would fetch all of them. 100 most-recent is plenty for a notification
 * tray.
 */
const MAX_UNREAD_NOTIFICATIONS = 100;

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly db: DatabaseService) {}

  async create<T extends NotificationType>(input: CreateNotificationInput<T>): Promise<void> {
    await this.db.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        payload: input.payload as unknown as InputJsonValue,
      },
    });
  }

  async createMany<T extends NotificationType>(inputs: CreateNotificationInput<T>[]): Promise<void> {
    this.logger.debug(`Creating ${inputs.length} notifications`);

    if (!inputs.length) {
      return;
    }

    await this.db.notification.createMany({
      data: inputs.map((i) => ({
        userId: i.userId,
        type: i.type,
        payload: i.payload as unknown as InputJsonValue,
      })),
    });
  }

  async getUnread(userId: string): Promise<UnreadNotificationDto[]> {
    const notifications = await this.db.notification.findMany({
      where: { userId, read: false },
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

  async markRead(userId: string, notificationIds: string[]): Promise<void> {
    this.logger.debug(`Marking ${notificationIds.length} notifications as read for user ${userId}`);
    await this.db.notification.updateMany({
      where: { id: { in: notificationIds }, userId },
      data: { read: true, readAt: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<void> {
    this.logger.debug(`Marking all notifications as read for user ${userId}`);
    await this.db.notification.updateMany({
      where: { userId, read: false },
      data: { read: true, readAt: new Date() },
    });
  }
}
