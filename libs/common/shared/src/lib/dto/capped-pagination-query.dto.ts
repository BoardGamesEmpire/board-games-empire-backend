import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsOptional, IsPositive, Max } from 'class-validator';
import { DEFAULT_MAX_PAGE_SIZE, PaginationQueryDto } from './pagination-query.dto';

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
 * page. `offset` is intentionally NOT re-declared, so its base
 * `@Max(DEFAULT_MAX_OFFSET)` is inherited unchanged.
 *
 * The return type is a concrete constructor (`new () => PaginationQueryDto`)
 * rather than `typeof PaginationQueryDto`: the base is `abstract`, and an
 * abstract constructor type cannot be extended, so the produced (concrete)
 * class is typed concretely to keep `extends CappedPaginationQueryDto(n)` valid.
 */
export function CappedPaginationQueryDto(maxLimit: number = DEFAULT_MAX_PAGE_SIZE): new () => PaginationQueryDto {
  class CappedPaginationQuery extends PaginationQueryDto {
    @ApiPropertyOptional({ description: 'Maximum items per page', maximum: maxLimit })
    @Type(() => Number)
    @IsPositive()
    @Max(maxLimit)
    @IsOptional()
    declare limit?: number;
  }

  return CappedPaginationQuery;
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
