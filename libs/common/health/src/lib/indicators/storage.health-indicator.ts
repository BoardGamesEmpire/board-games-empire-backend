import { StorageService } from '@bge/storage';
import { Injectable, Optional } from '@nestjs/common';
import { HealthIndicatorResult, HealthIndicatorService } from '@nestjs/terminus';

/**
 * Terminus health indicator for the storage backend.
 *
 * Calls the cheap, read-only `StorageService.ping()` (e.g. LocalDisk stats its
 * root) so orchestration pulls an instance whose volume is unmounted or whose
 * credentials expired *before* users hit 503/507s.
 *
 * `StorageService` is optional-injection: processes that don't load the (global)
 * `StorageModule` inject `undefined` and the check reports up with "not
 * configured" rather than failing readiness — same pattern as the Redis
 * indicators. No `@bge/storage` module import is needed; `StorageModule` is
 * `@Global()`, so the service is resolvable wherever it's loaded.
 */
@Injectable()
export class StorageHealthIndicator {
  constructor(
    private readonly healthIndicatorService: HealthIndicatorService,
    @Optional() private readonly storage?: StorageService,
  ) {}

  async isHealthy(key = 'storage'): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    if (!this.storage) {
      return indicator.up({ message: 'not configured' });
    }

    try {
      await this.storage.ping();
      return indicator.up();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return indicator.down({ message });
    }
  }
}
