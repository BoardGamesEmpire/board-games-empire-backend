import { actorUserId, AuditContextService } from '@bge/actor-context';
import { DatabaseService } from '@bge/database';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ImportJobCompletedEvent } from '../events/import.events';

@Injectable()
export class ImportActivityListener {
  private readonly logger = new Logger(ImportActivityListener.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly auditContext: AuditContextService,
  ) {}

  /**
   * Creates an ImportActivity record for every completed import job where a new game or
   * expansion was created in the system. This allows us to show a feed of
   * recent imports on the frontend and power related features like the "New
   * Expansions" section on game pages.
   */
  @OnEvent(ImportJobCompletedEvent.eventName, { async: true })
  async handle(event: ImportJobCompletedEvent): Promise<void> {
    const { gameId } = event.after;

    if (!event.sourceCreated) {
      return this.logger.debug(
        `ImportActivityListener skipping jobId=${event.subjectId} gameId=${gameId} ` +
          `created=${event.sourceCreated} isExpansion=${event.isExpansion}`,
      );
    }

    this.logger.debug(
      `ImportActivityListener recording activity for jobId=${event.subjectId} gameId=${gameId} ` +
        `isExpansion=${event.isExpansion}`,
    );

    // Requesting user comes from CLS (ActorAwareWorkerHost restores the
    // originating actor per job; EventEmitter2 propagates it into async
    // listeners) — null for system/external-initiated imports.
    const actor = this.auditContext.getActor();
    const importedById = actor ? actorUserId(actor) : null;

    try {
      await this.db.importActivity.create({
        data: {
          gameId,
          importedById,
          gatewayId: event.gatewayId,
          isExpansion: event.isExpansion,
          gameTitle: event.gameTitle,
          thumbnail: event.thumbnail,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write ImportActivity for gameId=${gameId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
