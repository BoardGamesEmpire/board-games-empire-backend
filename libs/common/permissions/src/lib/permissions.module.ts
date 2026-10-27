import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { CACHE_REDIS_CLIENT } from '@bge/redis';
import { Global, Module } from '@nestjs/common';
import { AbilityFactory } from './ability.factory';
import { AbilityService } from './ability.service';
import { AbilityContextMiddleware } from './middleware/ability-context.middleware';
import { createPermissionsCache, PERMISSIONS_CACHE } from './permissions-cache';
import { PermissionsService } from './permissions.service';
import { ScopeComposer } from './scope/scope-composer.service';
import { AbilityContextInternalService } from './services/ability-context-internal.service';

/**
 * `@Global()` so `AbilityService` (the public authorization read/prime surface)
 * is ambient — consumers inject it without importing PermissionsModule.
 *
 * `AuditContextModule` is imported for `AuditContextService`, which AbilityService
 * uses to read the current actor; `ClsModule` (global) supplies `ClsService`.
 *
 * `AbilityContextInternalService` is the internal CLS writer — a provider but
 * deliberately NOT exported. The only writer is `AbilityService.primeCurrentActor()`,
 * so no module outside this lib injects it; transports prime by calling the public
 * `AbilityService`. `AbilityContextMiddleware` is exported so the application can
 * apply it (after `HttpActorMiddleware`) in its `configure()`.
 *
 * `ScopeComposer` is exported alongside `AbilityService`, and depends on it —
 * never the reverse. That direction is what keeps scope off the authorization
 * service: a scope parameter on `AbilityService` would re-merge the two
 * concepts 365 separates, and the module graph now makes the merge visible.
 *
 * `PERMISSIONS_CACHE` is `PermissionsService`'s own cache, built over
 * `CACHE_REDIS_CLIENT` under one namespace every process shares (#786). Every
 * process that imports this module registers `RedisModule` with a cache
 * connection, which provides that client.
 */
@Global()
@Module({
  imports: [DatabaseModule, AuditContextModule],
  providers: [
    AbilityFactory,
    { provide: PERMISSIONS_CACHE, inject: [CACHE_REDIS_CLIENT], useFactory: createPermissionsCache },
    PermissionsService,
    AbilityService,
    AbilityContextInternalService,
    AbilityContextMiddleware,
    ScopeComposer,
  ],
  exports: [AbilityFactory, PermissionsService, AbilityService, AbilityContextMiddleware, ScopeComposer],
})
export class PermissionsModule {}
