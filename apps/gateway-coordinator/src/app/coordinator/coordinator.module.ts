import { DatabaseModule } from '@bge/database';
import { FlowProducerNames, QueueNames } from '@bge/game-import';
import { CACHE_REDIS_CLIENT, type Redis } from '@bge/redis';
import KeyvValkey from '@keyv/valkey';
import { BullModule } from '@nestjs/bullmq';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { CoordinatorController } from './coordinator.controller';
import { CoordinatorService } from './coordinator.service';
import { GameSearchService } from './game-search.service';
import { GameImportEnqueuerService } from './services/game-import-enqueuer.service';

@Module({
  imports: [
    DatabaseModule,
    CacheModule.registerAsync({
      inject: [CACHE_REDIS_CLIENT],
      useFactory: (redis: Redis) => ({
        stores: [new KeyvValkey(redis)],
        ttl: 300, // default TTL in seconds
      }),
    }),

    BullModule.registerQueue({ name: QueueNames.GamesImport }, { name: QueueNames.GatewayFetch }),
    BullModule.registerFlowProducer({ name: FlowProducerNames.GamesImport }),
  ],
  controllers: [CoordinatorController],
  providers: [CoordinatorService, GameSearchService, GameImportEnqueuerService],
})
export class CoordinatorModule {}
