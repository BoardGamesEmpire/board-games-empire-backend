import { Global, Module } from '@nestjs/common';
import { AuditContextInternalService } from './services/audit-context-internal.service';
import { AuditContextService } from './services/audit-context.service';
import { SystemActorScope } from './services/system-actor-scope.service';

/**
 * Registers:
 * - `AuditContextService` — public CLS reader (inject from anywhere).
 * - `AuditContextInternalService` — entry-point CLS populator (eslint-restricted
 *   to interceptors / worker bases — see the root eslint config).
 * - `SystemActorScope` — sanctioned wrapper for system-initiated work
 *   (health pings, scheduled tasks, bootstrap discovery). Mints a `system`
 *   actor with a caller-supplied reason. Public — inject from anywhere.
 *
 * Requires `ClsModule.forRoot({ global: true, ... })` to have been registered
 * elsewhere in the application. This module does not own the CLS lifecycle.
 *
 * Marked `@Global()` because the services are leaf accessors injected from
 * everywhere (controllers, services, listeners, workers); avoids re-importing
 * the module into every feature module.
 */
@Global()
@Module({
  providers: [AuditContextService, AuditContextInternalService, SystemActorScope],
  exports: [AuditContextService, AuditContextInternalService, SystemActorScope],
})
export class AuditContextModule {}
