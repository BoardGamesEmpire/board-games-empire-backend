import { actorUserId, AuditContextService } from '@bge/actor-context';
import { DatabaseService, NotificationType } from '@bge/database';
import type { CreateNotificationInput } from '@bge/notifications-service';
import { NotificationsService } from '@bge/notifications-service';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ImportJobCompletedEvent } from '../events/import.events';

/**
 * Notifies users who are watching a base game when one of its expansions
 * is imported for the first time. An expansion is an add-on with a base game,
 * whatever brought it into its import batch (#971).
 *
 * Skipped when:
 *   - created = false (re-import)
 *   - the game is not an expansion
 *   - none of its base games is in the game catalog yet (its batch is adding it)
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

    const { baseGameIds } = event;

    // An expansion whose base game its batch is adding is linked by the base
    // game's import, and a game new to the catalog has no watchers yet (#971).
    if (baseGameIds.length === 0) {
      return this.logger.debug(
        `GameWatchListener skipping: no base game in the catalog yet for jobId=${event.subjectId} gameId=${gameId}`,
      );
    }

    this.logger.debug(
      `GameWatchListener processing expansion import jobId=${event.subjectId} gameId=${gameId} ` +
        `baseGameIds=${baseGameIds.join(',')} for notification`,
    );

    // Importing user comes from CLS (ActorAwareWorkerHost restores the
    // originating actor per job) — null for system/external-initiated
    // imports, in which case no watcher is filtered out below.
    const actor = this.auditContext.getActor();
    const importingUserId = actor ? actorUserId(actor) : null;

    try {
      const watches = await this.db.gameWatch.findMany({
        where: { gameId: { in: baseGameIds } },
        select: {
          userId: true,
          gameId: true,
          game: { select: { title: true } },
        },
      });

      this.logger.debug(
        `Found ${watches.length} watches on base games ${baseGameIds.join(',')} when processing expansion import ${gameId}`,
      );

      // no watchers, nothing to do
      if (watches.length === 0) {
        return this.logger.debug(
          `GameWatchListener no watchers to notify for expansionId=${gameId} baseGameIds=${baseGameIds.join(',')}`,
        );
      }

      const inputs: CreateNotificationInput[] = firstWatchPerUser(watches, baseGameIds)
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
            baseGameId: w.gameId,
            baseGameTitle: w.game.title,
          },
        }));

      await this.notifications.createMany(inputs);

      this.logger.log(
        `Notified ${inputs.length} watchers of expansion import: expansionId=${gameId} baseGameIds=${baseGameIds.join(',')}`,
      );
    } catch (err) {
      this.logger.error(
        `GameWatchListener failed for expansionId=${gameId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}

/**
 * One watch per user: a user watching several of the expansion's base games
 * hears of it once, under the first of them its DataGateway named (#971).
 */
function firstWatchPerUser<T extends { userId: string; gameId: string }>(watches: T[], baseGameIds: string[]): T[] {
  const rank = (watch: T) => baseGameIds.indexOf(watch.gameId);
  const byUser = new Map<string, T>();

  for (const watch of [...watches].sort((a, b) => rank(a) - rank(b))) {
    if (!byUser.has(watch.userId)) {
      byUser.set(watch.userId, watch);
    }
  }

  return [...byUser.values()];
}
