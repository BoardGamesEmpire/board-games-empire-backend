import { DEFAULT_MAX_OFFSET, TransformBoolean } from '@bge/shared';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

export class SearchStartDto {
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

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(DEFAULT_MAX_OFFSET)
  @Type(() => Number)
  offset?: number;
}

export class SearchCancelDto {
  @IsUUID()
  correlationId!: string;
}
