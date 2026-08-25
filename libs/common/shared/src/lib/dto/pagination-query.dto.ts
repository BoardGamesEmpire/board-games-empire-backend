import { ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude, Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsPositive,
  Max,
  Min,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Page size used when a caller omits `limit` and the endpoint's DTO does not
 * name a default of its own (see `CappedPaginationQueryDto`). It lives here,
 * once, because
 * page-based paging makes it part of the *contract* rather than an internal
 * fallback: `skip` is derived from `(page - 1) × limit`, so a service-local
 * default (the old `take: limit || 10`) would silently redefine what "page 2"
 * means, and the echoed `pagination.limit` would disagree with the rows sent.
 * See D-230-3 on #230.
 */
export const DEFAULT_PAGE_SIZE = 25;

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
 * Ceiling on the derived `skip`. A bounded `take` still lets deep paging force
 * Prisma to `skip` (scan-and-discard) millions of rows per request — the same
 * self-DoS in a second dimension. This bounds the worst-case scan.
 *
 * NOTE: this is a hardening ceiling, not a real deep-pagination story. Clients
 * that must page past it should move to cursor/keyset pagination; offset paging
 * is O(skip) at the database regardless of this cap.
 */
export const DEFAULT_MAX_OFFSET = 100_000;

/**
 * Enforces the ceiling against the DERIVED skip rather than against `page`
 * directly (D-230-4 on #230). A fixed `@Max` on `page` would swing the
 * reachable row count by the size of `limit` — 100× between `limit=1` and
 * `limit=100` — and would bite legitimate callers first: games are a public
 * resource, so a large public instance is thousands of rows that a client pages
 * through at the default size. The row count is the thing worth bounding; the
 * page number is not.
 *
 * Because the check reads `limit` as well as `page`, it stays silent whenever
 * either input is not an integer: `?limit=abc` transforms to NaN, and reporting
 * a depth failure on `page` there would answer a question the caller did not
 * ask — the real error is `limit`, and its own validators already say so.
 */
@ValidatorConstraint({ name: 'skipWithinCeiling' })
class SkipWithinCeiling implements ValidatorConstraintInterface {
  validate(_page: unknown, args: ValidationArguments): boolean {
    const { page, limit, skip } = args.object as PaginationQueryDto;

    if (!Number.isInteger(page) || (limit !== undefined && !Number.isInteger(limit))) {
      return true;
    }

    return skip <= DEFAULT_MAX_OFFSET;
  }

  defaultMessage(): string {
    return `page is too deep: (page - 1) × limit must not exceed ${DEFAULT_MAX_OFFSET}`;
  }
}

/**
 * Shape-only base for page-based query DTOs. `abstract` on purpose: it carries
 * no `limit` cap, so binding it directly would be unbounded (the #11 self-DoS).
 * Endpoints must go through the factory instead — `DefaultPaginationQueryDto`
 * for the common case, or `CappedPaginationQueryDto(n)` for a specific ceiling.
 *
 * The wire contract is `page` (1-based) + `limit`; `offset` is NOT accepted, and
 * the global pipe runs `forbidNonWhitelisted`, so a stale `?offset=` is a loud
 * 400 rather than a silently ignored parameter (D-230-1 on #230). Transports
 * that must stay offset-native — the gateway search fan-out, whose proto
 * contract and upstream vendor APIs are offset/skip-based — extend
 * {@link OffsetPaginationQueryDto} instead (D-230-5).
 */
export abstract class PaginationQueryDto {
  // `@IsInt` alongside `@IsPositive`: a fractional `limit` would flow into both
  // `take` and the derived `skip`, and Prisma rejects a non-integer `take` with
  // a 500 rather than the 400 the caller earned.
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @IsOptional()
  limit?: number;

  @ApiPropertyOptional({ description: 'Page number, 1-based', minimum: 1, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Validate(SkipWithinCeiling)
  @IsOptional()
  page = 1;

  /**
   * The resolved page size: what the endpoint will actually `take`, and the
   * value the response envelope echoes as `pagination.limit`. Reading it here
   * rather than re-defaulting per service is what keeps the echoed limit and
   * the derived {@link skip} in agreement.
   */
  @Exclude()
  get pageSize(): number {
    return this.limit ?? DEFAULT_PAGE_SIZE;
  }

  /**
   * Prisma `skip` for the requested page. Offset survives as this derived
   * database argument and nothing else — it is no longer a client input.
   */
  @Exclude()
  get skip(): number {
    return (this.page - 1) * this.pageSize;
  }
}

/**
 * Shape-only base for the offset-native transports: the REST/WS game search
 * fan-out passes its paging straight through to gateways whose proto contract
 * carries `optional int32 offset`, and on to vendor APIs that are offset/skip
 * based (IGDB `.offset()`, BGG `skip(offset)`). Converting to `page` at that
 * boundary would only mean converting back, so those DTOs keep `offset` —
 * D-230-5 on #230.
 *
 * Same `abstract`-and-uncapped contract as {@link PaginationQueryDto}: go
 * through `CappedOffsetPaginationQueryDto(n)`, never bind this directly.
 */
export abstract class OffsetPaginationQueryDto {
  @Type(() => Number)
  @IsInt()
  @IsPositive()
  @IsOptional()
  limit?: number;

  /**
   * Bounded like {@link DEFAULT_MAX_OFFSET} describes. Unlike `limit`, `offset`
   * is declared here and re-declared nowhere, so it stays the single declarer
   * per chain and inherits cleanly (no class-validator union hazard).
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(DEFAULT_MAX_OFFSET)
  @IsOptional()
  offset = 0;
}
