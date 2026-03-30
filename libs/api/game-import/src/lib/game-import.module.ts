import { GatewayCoordinatorClientModule } from '@bge/coordinator';
import { DatabaseModule } from '@bge/database';
import { NotificationsServiceModule } from '@bge/notifications-service';
import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import redisConfiguration from './configuration/redis.config';
import { FlowProducerNames, QueueNames } from './constants/queue.constants';
import type { RedisOptions } from './interfaces/redis.interface';
import { GameWatchListener } from './listeners/game-watch.listener';
import { ImportActivityListener } from './listeners/import-activity.listener';
import { NotificationListener } from './listeners/notification.listener';
import { GameImportProcessor } from './processors/game-import.processor';
import { GameImportProducerService } from './services/game-import-producer.service';
import { GameUpsertService } from './services/game.service';
import { PersonUpsertService } from './services/person.service';
import { PlatformUpsertService } from './services/platform.service';
import { TaxonomyUpsertService } from './services/taxonomy.service';

@Module({
  imports: [
    ConfigModule.forFeature(redisConfiguration),
    DatabaseModule,
    GatewayCoordinatorClientModule,
    EventEmitterModule.forRoot(),
    NotificationsServiceModule,

    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisConfig = config.getOrThrow<RedisOptions>('redis.queue');
        return {
          connection: {
            host: redisConfig.socket.host,
            port: redisConfig.socket.port,
            username: redisConfig.username,
            password: redisConfig.password,
            database: redisConfig.database,
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
    PlatformUpsertService,
    GameUpsertService,
    GameImportProcessor,
    GameImportProducerService,
    GameWatchListener,
    NotificationListener,
    ImportActivityListener,
  ],
  exports: [GameImportProducerService],
})
export class GameImportModule {}
