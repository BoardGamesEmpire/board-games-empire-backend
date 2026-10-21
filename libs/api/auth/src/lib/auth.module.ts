import { AuditContextModule, AuditContextService, SystemActorScope } from '@bge/actor-context';
import { DatabaseModule, DatabaseService } from '@bge/database';
import type { I18nTranslations } from '@bge/i18n';
import { CACHE_REDIS_CLIENT, type Redis } from '@bge/redis';
import { ServicesModule } from '@bge/services';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuthModule as BetterAuthModule } from '@thallesp/nestjs-better-auth';
import { I18nService } from 'nestjs-i18n';
import { authFactory } from './auth-factory';
import { createAuthRequestHandler } from './auth-request-handler';
import { createRedisAuthStorage } from './auth-storage';
import { AuthService } from './auth.service';
import authConfig from './configuration/auth.config';
import { AUTH_INSTANCE, AUTH_REQUEST_HANDLER, MAX_REQUEST_BODY_BYTES } from './constants';
import type { AuthType } from './interfaces';
import { UserProvisioningListener } from './provisioning/user-provisioning.listener';
import { UserProvisioningService } from './provisioning/user-provisioning.service';
import { fallbackLocaleRenderer } from './setting-gates';

@Module({
  imports: [
    ConfigModule.forFeature(authConfig),
    DatabaseModule,
    ServicesModule,
    // AuditContextModule supplies the CLS reader + SystemActorScope used by
    // the user-created database hook (#57 emit-site migration).
    AuditContextModule,
    BetterAuthModule.forRootAsync({
      // The package's AuthGuard authenticates by calling getSession, so it
      // refuses every request an API key makes. The API app registers
      // ActorAuthGuard globally instead, which reads the actor
      // HttpActorMiddleware resolved (#529).
      disableGlobalAuthGuard: true,
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
        // Global: the app's RedisModule registers it. better-auth's storage
        // builds its own store on it, apart from CacheModule's (#640).
        cacheClient: Redis,
        eventEmitter: EventEmitter2,
        auditContext: AuditContextService,
        systemActorScope: SystemActorScope,
        // Global: the app's I18nConfigModule registers it. It renders the
        // settings gates' refusals (#585).
        i18n: I18nService<I18nTranslations>,
      ) =>
        authFactory(
          databaseClient,
          configService,
          createRedisAuthStorage(cacheClient),
          eventEmitter,
          auditContext,
          systemActorScope,
          i18n,
        ),
      inject: [
        DatabaseService,
        ConfigService,
        CACHE_REDIS_CLIENT,
        EventEmitter2,
        AuditContextService,
        SystemActorScope,
        I18nService,
      ],
    },
    {
      provide: AUTH_REQUEST_HANDLER,
      useFactory: (auth: AuthType, i18n: I18nService<I18nTranslations>) =>
        createAuthRequestHandler(auth.handler, { render: fallbackLocaleRenderer(i18n) }),
      inject: [AUTH_INSTANCE, I18nService],
    },
    AuthService,
    UserProvisioningService,
    UserProvisioningListener,
  ],
  exports: [AuthService, AUTH_INSTANCE, AUTH_REQUEST_HANDLER],
})
export class AuthModule {}
