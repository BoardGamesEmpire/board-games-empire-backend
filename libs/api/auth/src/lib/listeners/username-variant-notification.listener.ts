import { DatabaseService, NotificationType } from '@bge/database';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { UserCreatedEvent } from '../events/auth.events';

/**
 * Tells a new user that the username they asked for was taken (#912). A first
 * sign-in through a sign-in provider gets the first free variant, and the user
 * hears which one and whether they can change it.
 *
 * The event is emitted after the user row is written, so a handler never
 * throws: it logs its own failure and resolves, and the notification is lost
 * rather than the user.
 */
@Injectable()
export class UsernameVariantNotificationListener {
  private readonly logger = new Logger(UsernameVariantNotificationListener.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
  ) {}

  @OnEvent(UserCreatedEvent.eventName)
  async handle(event: UserCreatedEvent): Promise<void> {
    const { requestedUsername } = event;

    if (requestedUsername === null) {
      return;
    }

    try {
      // Read now, not at sign-in: the wording a client shows is fixed by what
      // the server allows when the notification is sent.
      const settings = await this.db.systemSetting.findUnique({
        where: { singleton: true },
        select: { allowUsernameChange: true },
      });

      await this.notifications.create({
        userId: event.subjectId,
        type: NotificationType.UsernameVariantAssigned,
        payload: {
          username: event.after.username,
          requestedUsername,
          // The username-change gate's own rule: without a settings row it
          // refuses a change, so the notification must not offer one.
          usernameChangeAllowed: settings?.allowUsernameChange === true,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to notify on UsernameVariantAssigned userId=${event.subjectId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
