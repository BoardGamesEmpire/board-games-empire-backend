import { Type } from 'class-transformer';
import { IsOptional, IsPositive, Max, Min } from 'class-validator';

/**
 * Default `limit` ceiling applied by the factory when a feature DTO does not
 * ask for a specific cap (see `CappedPaginationQueryDto` / `DefaultPaginationQueryDto`).
 *
 * It lives on the FACTORY, not this base class, on purpose. class-validator
 * unions inherited same-property metadata (stricter wins), so a `@Max` here
 * would become a hard floor every capped subclass is silently clamped to — an
 * endpoint could never opt into a larger page than the default. Keeping the
 * cap off the base leaves the factory the sole `limit`-cap declarer per chain,
 * so each endpoint's chosen `maxLimit` (e.g. audit logs at 200) actually holds.
 */
export const DEFAULT_MAX_PAGE_SIZE = 100;

/**
 * Ceiling on `offset`. A bounded `take` still lets an unbounded `offset` force
 * Prisma to `skip` (scan-and-discard) millions of rows per request — the same
 * self-DoS in a second dimension. This bounds the worst-case scan.
 *
 * Unlike `limit`, `offset` IS declared here: no subclass re-declares it, so it
 * stays the single declarer per chain and inherits cleanly (no union hazard).
 *
 * NOTE: this is a hardening ceiling, not a real deep-pagination story. Clients
 * that must page past it should move to cursor/keyset pagination; offset paging
 * is O(offset) at the database regardless of this cap.
 */
export const DEFAULT_MAX_OFFSET = 100_000;

/**
 * Shape-only base for paginated query DTOs. `abstract` on purpose: it carries
 * no `limit` cap, so binding it directly would be unbounded (the #11 self-DoS).
 * Endpoints must go through the factory instead — `DefaultPaginationQueryDto`
 * for the common case, or `CappedPaginationQueryDto(n)` for a specific ceiling.
 */
export abstract class PaginationQueryDto {
  @Type(() => Number)
  @IsPositive()
  @IsOptional()
  limit?: number;

  @Type(() => Number)
  @Min(0)
  @Max(DEFAULT_MAX_OFFSET)
  @IsOptional()
  offset = 0;
}
