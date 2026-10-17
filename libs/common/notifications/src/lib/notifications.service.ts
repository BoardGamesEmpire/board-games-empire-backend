import { DatabaseService, NotificationType } from '@bge/database';
import { Injectable, Logger } from '@nestjs/common';
import { InputJsonValue } from '@prisma/client/runtime/client';
import type { CreateNotificationInput } from './interfaces';

/**
 * Writes notifications, for the workers and listeners that raise them. Reading
 * them and marking them read is the API's (`UserNotificationsService` in
 * `@bge/notifications`), which composes the caller's ceiling and so needs the
 * permissions lib that this service, and every worker that imports it, does
 * without.
 */
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
}
