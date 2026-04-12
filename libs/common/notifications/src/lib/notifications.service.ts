import { DatabaseService } from '@bge/database';
import { Injectable, Logger } from '@nestjs/common';
import { InputJsonValue } from '@prisma/client/runtime/client';
import type { CreateNotificationInput, NotificationPayload, UnreadNotificationDto } from './interfaces';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(private readonly db: DatabaseService) {}

  async create(input: CreateNotificationInput): Promise<void> {
    await this.db.notification.create({
      data: {
        userId: input.userId,
        type: input.type,
        payload: input.payload ?? {},
      },
    });
  }

  async createMany(inputs: CreateNotificationInput[]): Promise<void> {
    this.logger.debug(`Creating ${inputs.length} notifications`);

    if (!inputs.length) {
      return;
    }

    await this.db.notification.createMany({
      data: inputs.map((i) => ({
        userId: i.userId,
        type: i.type,
        payload: i.payload as InputJsonValue,
      })),
    });
  }

  async getUnread(userId: string): Promise<UnreadNotificationDto[]> {
    const notifications = await this.db.notification.findMany({
      where: { userId, read: false },
      orderBy: { createdAt: 'desc' },
      select: { id: true, type: true, read: true, payload: true, createdAt: true },
    });

    this.logger.debug(`Found ${notifications.length} unread notifications for user ${userId}`);

    return notifications.map((notification) => ({
      id: notification.id,
      type: notification.type,
      read: notification.read,
      payload: notification.payload as NotificationPayload,
      createdAt: notification.createdAt,
    }));
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
