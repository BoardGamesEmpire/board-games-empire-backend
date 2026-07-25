import { Module } from '@nestjs/common';
import { AuditContextInternalService } from './services/audit-context-internal.service';
import { AuditContextService } from './services/audit-context.service';
import { PluginActorScope } from './services/plugin-actor-scope.service';
import { SystemActorScope } from './services/system-actor-scope.service';

/**
 * Registers:
 * - `AuditContextService` — public CLS reader (inject from anywhere).
 * - `AuditContextInternalService` — entry-point CLS populator (eslint-restricted
 *   to interceptors / worker bases — see the root eslint config).
 * - `SystemActorScope` — sanctioned wrapper for system-initiated work
 *   (health pings, scheduled tasks, bootstrap discovery). Mints a `system`
 *   actor with a caller-supplied reason. Public — inject from anywhere.
 * - `PluginActorScope` — sanctioned wrapper for plugin execution (#59).
 *   Mints a `plugin` actor whose trigger is the actor already in scope
 *   (or a named `system` fallback at boot). Public — inject from anywhere;
 *   cannot forge user / apiKey attribution.
 *
 * Requires `ClsModule.forRoot({ global: true, ... })` to have been registered
 * elsewhere in the application. This module does not own the CLS lifecycle.
 */
@Module({
  providers: [AuditContextService, AuditContextInternalService, SystemActorScope, PluginActorScope],
  exports: [AuditContextService, AuditContextInternalService, SystemActorScope, PluginActorScope],
})
export class AuditContextModule {}
