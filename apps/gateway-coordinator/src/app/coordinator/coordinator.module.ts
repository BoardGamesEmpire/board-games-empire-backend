import { DatabaseModule } from '@bge/database';
import { FlowProducerNames, QueueNames } from '@bge/game-import';
import { GATEWAY_REGISTRY_REDIS, GatewayRegistryModule } from '@bge/gateway-registry';
import KeyvRedis from '@keyv/redis';
import { BullModule } from '@nestjs/bullmq';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import type { RedisClientType } from 'redis';
import { CoordinatorController } from './coordinator.controller';
import { CoordinatorService } from './coordinator.service';
import { GameSearchService } from './game-search.service';
import { GameImportEnqueuerService } from './services/game-import-enqueuer.service';

@Module({
  imports: [
    DatabaseModule,
    CacheModule.registerAsync({
      imports: [GatewayRegistryModule],
      inject: [GATEWAY_REGISTRY_REDIS],
      useFactory: (redis: RedisClientType) => ({
        stores: [new KeyvRedis(redis)],
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
