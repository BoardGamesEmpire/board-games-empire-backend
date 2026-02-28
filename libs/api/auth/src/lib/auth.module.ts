import { DatabaseModule, DatabaseService } from '@bge/database';
import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { authFactory } from './auth-factory';
import authConfig from './configuration/auth.config';
import { UserProvisioningService } from './provisioning/user-provisioning.service';
import { StrategyController, StrategyService } from './strategy';

@Module({
  imports: [
    ConfigModule.forFeature(authConfig),
    DatabaseModule,
    BetterAuthModule.forRootAsync({
      useFactory: (
        databaseClient: DatabaseService,
        configService: ConfigService,
        cache: Cache,
        userProvisioningService: UserProvisioningService,
      ) => {
        const auth = authFactory(databaseClient, configService, cache, userProvisioningService);
        return { auth };
      },
      imports: [DatabaseModule, AuthModule],
      inject: [DatabaseService, ConfigService, CACHE_MANAGER, UserProvisioningService],
    }),
  ],
  controllers: [StrategyController],
  providers: [StrategyService, UserProvisioningService],
  exports: [StrategyService, UserProvisioningService],
})
export class AuthModule {}
