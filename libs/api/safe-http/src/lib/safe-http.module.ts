import { AuditContextModule } from '@bge/actor-context';
import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { SafeHttpController } from './safe-http.controller';
import { SafeHttpService } from './safe-http.service';

/**
 * Admin endpoints for the `SafeHttpPolicy` singleton. Read access is gated
 * by `read:safe_http_policy`, mutation by `manage:safe_http_policy`. Both
 * permissions are seeded by `prisma/seeds/roles-permissions.seed.ts`.
 *
 * Imports:
 *   - `DatabaseModule` — Prisma client.
 *   - `AuditContextModule` — supplies `AuditContextService` to stamp `updatedBy`
 *     with the caller's ID from CLS. Imported explicitly (no longer `@Global()`).
 * `SecureHttpModule` (global) supplies `SafeHttpPolicyEventsService` for the
 * Redis pub/sub hot-reload after writes commit.
 */
@Module({
  imports: [DatabaseModule, AuditContextModule],
  controllers: [SafeHttpController],
  providers: [SafeHttpService],
})
export class SafeHttpModule {}
