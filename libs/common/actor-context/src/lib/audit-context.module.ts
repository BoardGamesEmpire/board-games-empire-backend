import { Global, Module } from '@nestjs/common';

import { AuditContextInternalService } from './services/audit-context-internal.service';
import { AuditContextService } from './services/audit-context.service';

/**
 * Registers `AuditContextService` (public reader) and
 * `AuditContextInternalService` (entry-point populator).
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
  providers: [AuditContextService, AuditContextInternalService],
  exports: [AuditContextService, AuditContextInternalService],
})
export class AuditContextModule {}
