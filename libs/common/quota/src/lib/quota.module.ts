import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { QuotaService } from './quota.service';
import { QuotaResourceRegistry } from './registry/quota-resource.registry';

/**
 * Enforcement core. Exported so any domain module can inject `QuotaService` and
 * call `check(...)` on its write paths. EventEmitter2 is provided globally by
 * the app's EventEmitterModule (used for `quota.updated` / `quota.soft_overage`).
 * The admin HTTP surface lives in the separate `@bge/quotas` API lib.
 */
@Module({
  imports: [DatabaseModule],
  providers: [QuotaService, QuotaResourceRegistry],
  exports: [QuotaService, QuotaResourceRegistry],
})
export class QuotaModule {}
