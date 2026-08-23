import { ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude, Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, Max } from 'class-validator';
import {
  DEFAULT_MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  OffsetPaginationQueryDto,
  PaginationQueryDto,
} from './pagination-query.dto';

/**
 * Builds a concrete `PaginationQueryDto` subclass whose `limit` is capped at
 * `maxLimit` (defaulting to `DEFAULT_MAX_PAGE_SIZE`). This factory is the ONLY
 * place a `limit` cap is declared — the base is abstract and cap-less — so a
 * feature DTO gets its ceiling here and nowhere else:
 *
 *   export class ListWidgetsQueryDto extends CappedPaginationQueryDto(250) {}
 *
 * Being the sole `limit`-cap declarer per inheritance chain is what lets each
 * endpoint pick any ceiling (audit logs 200, collections 100) without a base
 * default silently clamping it: class-validator unions inherited same-property
 * metadata and the STRICTER `@Max` wins, so a competing base `@Max` would cap
 * everyone at the smaller of the two.
 *
 * The full validation chain (`@Type`, `@IsPositive`, `@IsOptional`) is
 * re-declared here alongside `@Max`, NOT just the `@Max` cap: re-declaring a
 * property replaces the parent's metadata for it, so declaring `@Max` alone
 * would drop the inherited `@IsPositive` and let `limit=-50` through as
 * `take:-50` (oldest rows on a newest-first endpoint) / `limit=0` as an empty
 * page. `page` is intentionally NOT re-declared, so its base validators — and
 * the derived-skip ceiling — are inherited unchanged.
 *
 * `declare` (not a plain re-declaration) matters under the repo's `es2024`
 * target: define-semantics class fields would emit `limit = undefined` here and
 * clobber whatever the pipe transformed. `declare` emits nothing and only
 * carries the decorators.
 *
 * `defaultPageSize` overrides what `pageSize` resolves to when the caller omits
 * `limit`. Pass it only where the endpoint has a deliberate, named default
 * (audit logs page at 50); leaving it off adopts the shared `DEFAULT_PAGE_SIZE`,
 * which is what D-230-3 wants for endpoints whose old default was an arbitrary
 * service-local literal. It belongs here rather than in the service because
 * `skip` is derived from it — a service-local default would desynchronise the
 * rows from the page they claim to be.
 *
 * The return type is a concrete constructor (`new () => PaginationQueryDto`)
 * rather than `typeof PaginationQueryDto`: the base is `abstract`, and an
 * abstract constructor type cannot be extended, so the produced (concrete)
 * class is typed concretely to keep `extends CappedPaginationQueryDto(n)` valid.
 */
export function CappedPaginationQueryDto(
  maxLimit: number = DEFAULT_MAX_PAGE_SIZE,
  defaultPageSize: number = DEFAULT_PAGE_SIZE,
): new () => PaginationQueryDto {
  // A default above the cap would serve more rows than `?limit=` is allowed to
  // ask for, because the default is applied in the getter and never sees `@Max`.
  // Contradictory arguments are a wiring mistake, so fail at module load.
  if (defaultPageSize > maxLimit) {
    throw new RangeError(`defaultPageSize (${defaultPageSize}) cannot exceed maxLimit (${maxLimit})`);
  }

  class CappedPaginationQuery extends PaginationQueryDto {
    @ApiPropertyOptional({
      description: 'Maximum items per page',
      maximum: maxLimit,
      default: defaultPageSize,
    })
    @Type(() => Number)
    @IsInt()
    @IsPositive()
    @Max(maxLimit)
    @IsOptional()
    declare limit?: number;

    @Exclude()
    override get pageSize(): number {
      return this.limit ?? defaultPageSize;
    }
  }

  return CappedPaginationQuery;
}

/**
 * The offset-native counterpart of {@link CappedPaginationQueryDto}, for the
 * gateway search transports described on {@link OffsetPaginationQueryDto}. The
 * cap reasoning above applies verbatim; the two factories are kept separate
 * rather than generic over their base because the `@Max`-union hazard is worth
 * reading in full at each declaration site.
 */
export function CappedOffsetPaginationQueryDto(
  maxLimit: number = DEFAULT_MAX_PAGE_SIZE,
): new () => OffsetPaginationQueryDto {
  class CappedOffsetPaginationQuery extends OffsetPaginationQueryDto {
    @ApiPropertyOptional({ description: 'Maximum items per page', maximum: maxLimit })
    @Type(() => Number)
    @IsInt()
    @IsPositive()
    @Max(maxLimit)
    @IsOptional()
    declare limit?: number;
  }

  return CappedOffsetPaginationQuery;
}

/**
 * Ready-made pagination DTO for endpoints that just want the default ceiling
 * (`DEFAULT_MAX_PAGE_SIZE`). Bind this — never the abstract base — from a
 * controller `@Query()`, or extend it to add filters:
 *
 *   list(@Query() pagination: DefaultPaginationQueryDto) { ... }
 *   export class ListWidgetsQueryDto extends DefaultPaginationQueryDto {}
 */
export class DefaultPaginationQueryDto extends CappedPaginationQueryDto() {}
