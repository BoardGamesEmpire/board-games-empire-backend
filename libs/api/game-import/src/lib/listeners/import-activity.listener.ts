import { DatabaseService } from '@bge/database';
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ImportEvents } from '../constants/queue.constants';
import type { ImportJobCompletedEvent } from '../interfaces/import-job.interface';

@Injectable()
export class ImportActivityListener {
  private readonly logger = new Logger(ImportActivityListener.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Creates an ImportActivity record for every completed import job where a new game or
   * expansion was created in the system. This allows us to show a feed of
   * recent imports on the frontend and power related features like the "New
   * Expansions" section on game pages.
   */
  @OnEvent(ImportEvents.JobCompleted, { async: true })
  async handle(event: ImportJobCompletedEvent): Promise<void> {
    if (!event.sourceCreated) {
      return this.logger.debug(
        `ImportActivityListener skipping jobId=${event.jobId} gameId=${event.gameId} ` +
          `created=${event.sourceCreated} isExpansion=${event.isExpansion}`,
      );
    }

    this.logger.debug(
      `ImportActivityListener recording activity for jobId=${event.jobId} gameId=${event.gameId} ` +
        `isExpansion=${event.isExpansion}`,
    );

    try {
      await this.db.importActivity.create({
        data: {
          gameId: event.gameId,
          importedById: event.userId,
          gatewayId: event.gatewayId,
          isExpansion: event.isExpansion,
          gameTitle: event.gameTitle,
          thumbnail: event.thumbnail,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to write ImportActivity for gameId=${event.gameId}`,
        err instanceof Error ? err.stack : String(err),
      );
    }
  }
}
