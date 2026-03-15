import { DatabaseModule, DatabaseService } from '@bge/database';
import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { authFactory } from './auth-factory';
import authConfig from './configuration/auth.config';
import { AUTH_INSTANCE } from './constants';
import { UserProvisioningService } from './provisioning/user-provisioning.service';
import { StrategyController, StrategyService } from './strategy';

@Module({
  imports: [
    ConfigModule.forFeature(authConfig),
    DatabaseModule,
    BetterAuthModule.forRootAsync({
      useFactory: (auth: ReturnType<typeof authFactory>) => ({ auth }),
      imports: [AuthModule],
      inject: [AUTH_INSTANCE],
    }),
  ],
  controllers: [StrategyController],
  providers: [
    {
      provide: AUTH_INSTANCE,
      useFactory: (
        databaseClient: DatabaseService,
        configService: ConfigService,
        cache: Cache,
        userProvisioningService: UserProvisioningService,
      ) => authFactory(databaseClient, configService, cache, userProvisioningService),
      inject: [DatabaseService, ConfigService, CACHE_MANAGER, UserProvisioningService],
    },
    StrategyService,
    UserProvisioningService,
  ],
  exports: [StrategyService, UserProvisioningService, AUTH_INSTANCE],
})
export class AuthModule {}
