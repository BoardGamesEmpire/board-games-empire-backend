import { AuthModule } from '@bge/auth';
import { Module } from '@nestjs/common';
import { GrpcActorInterceptor } from './grpc-actor.interceptor';
import { HttpActorInterceptor } from './http-actor.interceptor';
import { WsActorInterceptor } from './ws-actor.interceptor';

/**
 * Registers the HTTP, gRPC, and WS actor interceptors.
 *
 * Requires the common `AuditContextModule` and `ClsModule.forRoot(...)` to be
 * available in the application module graph.
 *
 * The HTTP interceptor injects `AuthService` from `@bge/auth`; `AuthModule`
 * is imported here so it's transitively available without forcing the
 * application to re-import it for this purpose.
 *
 * Interceptors are exported as providers — the consumer registers them
 * globally via `APP_INTERCEPTOR` (or per-controller / per-gateway) in the
 * application bootstrap. Each interceptor short-circuits for non-matching
 * transport types, so all three can safely be registered globally.
 */
@Module({
  imports: [AuthModule],
  providers: [HttpActorInterceptor, GrpcActorInterceptor, WsActorInterceptor],
  exports: [HttpActorInterceptor, GrpcActorInterceptor, WsActorInterceptor],
})
export class ActorContextTransportModule {}
