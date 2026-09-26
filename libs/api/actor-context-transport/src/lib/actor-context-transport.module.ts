import { AuditContextModule } from '@bge/actor-context';
import { AuthModule } from '@bge/auth';
import { I18nConfigModule } from '@bge/i18n';
import { Module } from '@nestjs/common';
import { HttpActorMiddleware } from './middleware/http-actor.middleware';
import { LocaleResolutionMiddleware } from './middleware/locale-resolution.middleware';
import { WsActorScope } from './services/ws-actor-scope.service';

/**
 * Registers the entry-seam CLS populators: the HTTP actor + locale
 * middleware and the WS actor scope.
 *
 * Requires the common `AuditContextModule` and `ClsModule.forRoot(...)` to be
 * available in the application module graph.
 *
 * The HTTP middleware injects `AuthService` from `@bge/auth`, and the locale
 * middleware `LocaleResolutionService` from `@bge/i18n`; both modules are
 * imported here so they're transitively available without forcing the
 * application to re-import them for this purpose.
 *
 * The application applies the middleware in its `configure()`. The API's
 * WebSocket gateways open `WsActorScope` around every frame they receive.
 */
@Module({
  imports: [AuthModule, AuditContextModule, I18nConfigModule],
  providers: [HttpActorMiddleware, LocaleResolutionMiddleware, WsActorScope],
  exports: [HttpActorMiddleware, LocaleResolutionMiddleware, WsActorScope],
})
export class ActorContextTransportModule {}
