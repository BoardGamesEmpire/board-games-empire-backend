import { DatabaseModule, DatabaseService } from '@bge/database';
import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { authFactory } from './auth-factory';
import { AuthService } from './auth.service';
import authConfig from './configuration/auth.config';
import { AUTH_INSTANCE } from './constants';
import type { AuthType } from './interfaces';
import { UserProvisioningListener } from './provisioning/user-provisioning.listener';
import { UserProvisioningService } from './provisioning/user-provisioning.service';

@Module({
  imports: [
    ConfigModule.forFeature(authConfig),
    DatabaseModule,
    BetterAuthModule.forRootAsync({
      useFactory: (auth: AuthType) => ({ auth }),
      imports: [AuthModule],
      inject: [AUTH_INSTANCE],
    }),
  ],
  providers: [
    {
      provide: AUTH_INSTANCE,
      useFactory: (
        databaseClient: DatabaseService,
        configService: ConfigService,
        cache: Cache,
        eventEmitter: EventEmitter2,
      ) => authFactory(databaseClient, configService, cache, eventEmitter),
      inject: [DatabaseService, ConfigService, CACHE_MANAGER, EventEmitter2],
    },
    AuthService,
    UserProvisioningService,
    UserProvisioningListener,
  ],
  exports: [AuthService, AUTH_INSTANCE],
})
export class AuthModule {}
