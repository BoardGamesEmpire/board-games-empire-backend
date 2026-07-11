import { CappedPaginationQueryDto, TransformBoolean } from '@bge/shared';
import { IsArray, IsBoolean, IsOptional, IsString, IsUUID } from 'class-validator';

export class SearchStartDto extends CappedPaginationQueryDto(100) {
  @IsUUID()
  correlationId!: string;

  @IsString()
  query!: string;

  /**
   * Gateway IDs to include in the search.
   */
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  gatewayIds?: string[];

  /**
   * Whether to include the local DB in the search.
   * Defaults to true — local results are always fast-pathed in parallel.
   */
  @IsOptional()
  @IsBoolean()
  @TransformBoolean()
  includeLocal?: boolean = true;

  /**
   * Whether to include external sources in the search.
   * Defaults to true — external results are always fast-pathed in parallel.
   */
  @IsOptional()
  @IsBoolean()
  @TransformBoolean()
  includeExternal?: boolean = true;

  @IsOptional()
  @IsString()
  locale?: string;

  // `limit` (capped at 100) and `offset` (bounded by DEFAULT_MAX_OFFSET, default 0)
  // are inherited from CappedPaginationQueryDto — see #17.
}

export class SearchCancelDto {
  @IsUUID()
  correlationId!: string;
}
