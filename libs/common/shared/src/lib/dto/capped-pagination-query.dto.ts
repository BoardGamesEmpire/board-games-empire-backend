import { ApiPropertyOptional } from '@nestjs/swagger';
import { Max } from 'class-validator';
import { PaginationQueryDto } from './pagination-query.dto';

/**
 * Builds a `PaginationQueryDto` subclass whose `limit` is capped at
 * `maxLimit`. Feature DTOs extend the returned class instead of re-declaring
 * the same `@Max` override per lib:
 *
 *   export class ListWidgetsQueryDto extends CappedPaginationQueryDto(100) {}
 */
export function CappedPaginationQueryDto(maxLimit: number): typeof PaginationQueryDto {
  class CappedPaginationQuery extends PaginationQueryDto {
    @ApiPropertyOptional({ description: 'Maximum items per page', maximum: maxLimit })
    @Max(maxLimit)
    declare limit?: number;
  }

  return CappedPaginationQuery;
}
