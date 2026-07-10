import { actorUserId, AuditContextService } from '@bge/actor-context';
import { DatabaseService, NotificationType } from '@bge/database';
import type { CreateNotificationInput } from '@bge/notifications-service';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ImportJobCompletedEvent } from '../events/import.events';

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

  constructor(
    private readonly db: DatabaseService,
    private readonly notifications: NotificationsService,
    private readonly auditContext: AuditContextService,
  ) {}

  @OnEvent(ImportJobCompletedEvent.eventName, { async: true })
  async handle(event: ImportJobCompletedEvent): Promise<void> {
    const { gameId } = event.after;

    if (!event.sourceCreated) {
      return this.logger.debug(
        `GameWatchListener skipping: re-import, no new source for jobId=${event.subjectId} gameId=${gameId}`,
      );
    }

    if (!event.isExpansion) {
      return this.logger.debug(
        `GameWatchListener skipping: not an expansion, no watchers to notify for jobId=${event.subjectId} gameId=${gameId}`,
      );
    }

    if (!event.baseGameId) {
      return this.logger.warn(`GameWatchListener skipping: expansion jobId=${event.subjectId} has no baseGameId`);
    }

    this.logger.debug(
      `GameWatchListener processing expansion import jobId=${event.subjectId} gameId=${gameId} ` +
        `baseGameId=${event.baseGameId} for notification`,
    );

    // Importing user comes from CLS (ActorAwareWorkerHost restores the
    // originating actor per job) — null for system/external-initiated
    // imports, in which case no watcher is filtered out below.
    const actor = this.auditContext.getActor();
    const importingUserId = actor ? actorUserId(actor) : null;

    try {
      const watchers = await this.db.gameWatch.findMany({
        where: { gameId: event.baseGameId },
        select: {
          userId: true,
          game: { select: { title: true } },
        },
      });

      this.logger.debug(
        `Found ${watchers.length} watchers for base game ${event.baseGameId} when processing expansion import ${gameId}`,
      );

      // no watchers, nothing to do
      if (watchers.length === 0) {
        return this.logger.debug(
          `GameWatchListener no watchers to notify for expansionId=${gameId} baseGameId=${event.baseGameId}`,
        );
      }

      // Fetch base game title once — shared by all watcher notifications
      const baseGameTitle = watchers[0]!.game.title;
      const inputs: CreateNotificationInput[] = watchers
        // Importing user already gets an ExpansionImported notification via
        // NotificationListener — skip them here to avoid a duplicate
        .filter((w) => w.userId !== importingUserId)
        .map((w) => ({
          userId: w.userId,
          type: NotificationType.WatchedExpansionImported,
          payload: {
            gameId,
            gameTitle: event.gameTitle,
            thumbnail: event.thumbnail,
            baseGameId: event.baseGameId!,
            baseGameTitle,
          },
        }));

      await this.notifications.createMany(inputs);

      this.logger.log(
        `Notified ${inputs.length} watchers of expansion import: expansionId=${gameId} baseGameId=${event.baseGameId}`,
      );
    } catch (err) {
      this.logger.error(
        `GameWatchListener failed for expansionId=${gameId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
