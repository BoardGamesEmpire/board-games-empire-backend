import { DatabaseModule } from '@bge/database';
import { Module } from '@nestjs/common';
import { SafeHttpController } from './safe-http.controller';
import { SafeHttpService } from './safe-http.service';

/**
 * Admin endpoints for the `SafeHttpPolicy` singleton. Read access is gated
 * by `read:safe_http_policy`, mutation by `manage:safe_http_policy`. Both
 * permissions are seeded by `prisma/seeds/roles-permissions.seed.ts`.
 *
 * Dependencies are resolved from global modules registered at AppModule:
 *   - `DatabaseModule` (global) — Prisma client.
 *   - `SafeHttpModule` (global) — supplies `SafeHttpPolicyEventsService` for
 *     the Redis pub/sub hot-reload notification after writes commit.
 *   - `AuditContextModule` (global) — supplies `AuditContextService` so the
 *     service can stamp `updatedBy` with the calling user's ID from CLS.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [SafeHttpController],
  providers: [SafeHttpService],
})
export class SafeHttpModule {}
