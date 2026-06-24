import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { QueueNames } from './constants/queue.constants';
import { GameFetchProcessor } from './processors/game-fetch.processor';

/**
 * Fetch-side module. Imported by apps/gateway-worker. Owns the BullMQ
 * processor for GameFetch / ExpansionFetch jobs. Depends on the globally-
 * available GatewayRegistryService for actual gateway access
 */
@Module({
  imports: [
    AuditContextModule,
    DatabaseModule,
    BullModule.registerQueue({
      name: QueueNames.GatewayFetch,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    }),
  ],
  providers: [GameFetchProcessor],
})
export class GameImportFetchModule {}
