import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { Global, Module } from '@nestjs/common';
import { AbilityFactory } from './ability.factory';
import { AbilityService } from './ability.service';
import { AbilityContextMiddleware } from './middleware/ability-context.middleware';
import { PermissionsService } from './permissions.service';
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
 */
@Global()
@Module({
  imports: [DatabaseModule, AuditContextModule],
  providers: [
    AbilityFactory,
    PermissionsService,
    AbilityService,
    AbilityContextInternalService,
    AbilityContextMiddleware,
  ],
  exports: [AbilityFactory, PermissionsService, AbilityService, AbilityContextMiddleware],
})
export class PermissionsModule {}
