import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { FlowProducerNames, QueueNames } from './constants/queue.constants';
import { GamesImportGateway } from './games-import.gateway';
import type { RedisOptions } from './interfaces/redis.interface';
import { GameImportProcessor } from './processors/game-import.processor';
import { GamesImportProducerService } from './services/game-import-producer.service';
import { GameUpsertService } from './services/game.service';
import { PersonUpsertService } from './services/person.service';
import { TaxonomyUpsertService } from './services/taxonomy.service';

@Module({
  imports: [
    DatabaseModule,
    GatewayCoordinatorClientModule,
    EventEmitterModule.forRoot(),
    NotificationsServiceModule,

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisConfig = config.getOrThrow<RedisOptions>('redis');
        return {
          connection: {
            host: redisConfig.socket.host,
            port: redisConfig.socket.port,
            username: redisConfig.username,
            password: redisConfig.password,
            // TODO: Make this configurable
            database: 4,
          },
        };
      },
    }),

    BullModule.registerQueue({ name: QueueNames.GamesImport }),
    BullModule.registerFlowProducer({ name: FlowProducerNames.GamesImport }),
  ],
  providers: [
    TaxonomyUpsertService,
    PersonUpsertService,
    GameUpsertService,
    GameImportProcessor,
    GamesImportProducerService,
    GamesImportGateway,
  ],
  exports: [GamesImportProducerService],
})
export class GamesImportModule {}
