import { AuditContextModule } from '@bge/actor-context';
import { AuthModule } from '@bge/auth';
import { I18nConfigModule } from '@bge/i18n';
import { Module } from '@nestjs/common';
import { WsActorInterceptor } from './interceptors/ws-actor.interceptor';
import { HttpActorMiddleware } from './middleware/http-actor.middleware';
import { LocaleResolutionMiddleware } from './middleware/locale-resolution.middleware';

/**
 * Registers the entry-seam CLS populators: the HTTP actor + locale
 * middleware and the WS actor interceptor.
 *
 * Requires the common `AuditContextModule` and `ClsModule.forRoot(...)` to be
 * available in the application module graph.
 *
 * The HTTP middleware injects `AuthService` from `@bge/auth`, and the locale
 * middleware `LocaleResolutionService` from `@bge/i18n`; both modules are
 * imported here so they're transitively available without forcing the
 * application to re-import them for this purpose.
 *
 * Interceptors are exported as providers — the consumer registers them
 * globally via `APP_INTERCEPTOR` (or per-controller / per-gateway) in the
 * application bootstrap. Each interceptor short-circuits for non-matching
 * transport types, so all can safely be registered globally.
 */
@Module({
  imports: [AuthModule, AuditContextModule, I18nConfigModule],
  providers: [HttpActorMiddleware, LocaleResolutionMiddleware, WsActorInterceptor],
  exports: [HttpActorMiddleware, LocaleResolutionMiddleware, WsActorInterceptor],
})
export class ActorContextTransportModule {}
