import { DatabaseService, NotificationType } from '@bge/database';
import type { CreateNotificationInput } from '@bge/notifications-service';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ImportEvents } from '../constants/queue.constants';
import type { ImportJobCompletedEvent } from '../interfaces/import-job.interface';

/**
 * Notifies users who are watching the base game when one of its expansions
 * is imported for the first time.
 *
 * Skipped when:
 *   - created = false (re-import)
 *   - isExpansion = false (base game imports don't trigger watch notifications)
 *   - baseGameId is absent (should not happen for a valid expansion import)
 */
@Injectable()
export class GameWatchListener {
  private readonly logger = new Logger(GameWatchListener.name);

  constructor(private readonly db: DatabaseService, private readonly notifications: NotificationsService) {}

  @OnEvent(ImportEvents.JobCompleted, { async: true })
  async handle(event: ImportJobCompletedEvent): Promise<void> {
    if (!event.sourceCreated) {
      return this.logger.debug(
        `GameWatchListener skipping: re-import, no new source for jobId=${event.jobId} gameId=${event.gameId}`,
      );
    }

    if (!event.isExpansion) {
      return this.logger.debug(
        `GameWatchListener skipping: not an expansion, no watchers to notify for jobId=${event.jobId} gameId=${event.gameId}`,
      );
    }

    if (!event.baseGameId) {
      return this.logger.warn(`GameWatchListener skipping: expansion jobId=${event.jobId} has no baseGameId`);
    }

    this.logger.debug(
      `GameWatchListener processing expansion import jobId=${event.jobId} gameId=${event.gameId} ` +
        `baseGameId=${event.baseGameId} for notification`,
    );

    try {
      const watchers = await this.db.gameWatch.findMany({
        where: { gameId: event.baseGameId },
        select: {
          userId: true,
          game: { select: { title: true } },
        },
      });

      this.logger.debug(
        `Found ${watchers.length} watchers for base game ${event.baseGameId} when processing expansion import ${event.gameId}`,
      );

      // no watchers, nothing to do
      if (watchers.length === 0) {
        return this.logger.debug(
          `GameWatchListener no watchers to notify for expansionId=${event.gameId} baseGameId=${event.baseGameId}`,
        );
      }

      // Fetch base game title once — shared by all watcher notifications
      const baseGameTitle = watchers[0]!.game.title;
      const inputs: CreateNotificationInput[] = watchers
        // Importing user already gets an ExpansionImported notification via
        // NotificationListener — skip them here to avoid a duplicate
        .filter((w) => w.userId !== event.userId)
        .map((w) => ({
          userId: w.userId,
          type: NotificationType.WatchedExpansionImported,
          payload: {
            gameId: event.gameId,
            gameTitle: event.gameTitle,
            thumbnail: event.thumbnail,
            baseGameId: event.baseGameId!,
            baseGameTitle,
          },
        }));

      await this.notifications.createMany(inputs);

      this.logger.log(
        `Notified ${inputs.length} watchers of expansion import: expansionId=${event.gameId} baseGameId=${event.baseGameId}`,
      );
    } catch (err) {
      this.logger.error(
        `GameWatchListener failed for expansionId=${event.gameId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
