import { DatabaseModule } from '@bge/database';
import KeyvRedis from '@keyv/redis';
import { CacheModule } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { GatewayRegistryModule } from '../gateway-registry/gateway-registry.module';
import { CoordinatorController } from './coordinator.controller';
import { CoordinatorService } from './coordinator.service';
import { GameSearchService } from './game-search.service';

@Module({
  imports: [
    DatabaseModule,
    GatewayRegistryModule,
    CacheModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        stores: [new KeyvRedis(config.getOrThrow('redis'))],
        ttl: config.get<number>('cache.ttl'),
      }),
    }),
  ],
  controllers: [CoordinatorController],
  providers: [CoordinatorService, GameSearchService],
})
export class CoordinatorModule {}
