import { AuditContextModule, AuditContextService, SystemActorScope } from '@bge/actor-context';
import { DatabaseModule, DatabaseService } from '@bge/database';
import { ServicesModule } from '@bge/services';
import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { authFactory } from './auth-factory';
import { AuthService } from './auth.service';
import authConfig from './configuration/auth.config';
import { AUTH_INSTANCE, MAX_REQUEST_BODY_BYTES } from './constants';
import type { AuthType } from './interfaces';
import { UserProvisioningListener } from './provisioning/user-provisioning.listener';
import { UserProvisioningService } from './provisioning/user-provisioning.service';

@Module({
  imports: [
    ConfigModule.forFeature(authConfig),
    DatabaseModule,
    ServicesModule,
    // AuditContextModule supplies the CLS reader + SystemActorScope used by
    // the user-created database hook (#57 emit-site migration).
    AuditContextModule,
    BetterAuthModule.forRootAsync({
      // better-auth re-adds the app-wide body parsers (Nest's are disabled in
      // main.ts so better-auth can read raw bodies on its own routes). Cap them
      // here — the only place the limit can be set. See MAX_REQUEST_BODY_BYTES.
      useFactory: (auth: AuthType) => ({
        auth,
        bodyParser: {
          json: { limit: MAX_REQUEST_BODY_BYTES },
          urlencoded: { limit: MAX_REQUEST_BODY_BYTES },
        },
      }),
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
        auditContext: AuditContextService,
        systemActorScope: SystemActorScope,
      ) => authFactory(databaseClient, configService, cache, eventEmitter, auditContext, systemActorScope),
      inject: [DatabaseService, ConfigService, CACHE_MANAGER, EventEmitter2, AuditContextService, SystemActorScope],
    },
    AuthService,
    UserProvisioningService,
    UserProvisioningListener,
  ],
  exports: [AuthService, AUTH_INSTANCE],
})
export class AuthModule {}
