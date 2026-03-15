import { Type } from 'class-transformer';
import { IsArray, IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

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
  gatewayIds!: string[];

  /**
   * Whether to include the local DB in the search.
   * Defaults to true — local results are always fast-pathed in parallel.
   */
  @IsOptional()
  includeLocal?: boolean = true;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  offset?: number;
}

export class SearchCancelDto {
  @IsUUID()
  correlationId!: string;
}
