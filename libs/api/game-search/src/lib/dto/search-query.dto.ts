import { CappedPaginationQueryDto, TransformBoolean } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class SearchQueryDto extends CappedPaginationQueryDto(100) {
  @ApiProperty({ description: 'Search query string' })
  @IsString()
  query!: string;

  @ApiPropertyOptional({
    description: 'Comma-separated gateway IDs to include. Empty = all active gateways.',
    type: String,
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  gatewayIds?: string[];

  @ApiPropertyOptional({ description: 'Include local DB results', default: true })
  @IsOptional()
  @IsBoolean()
  @TransformBoolean()
  includeLocal?: boolean = true;

  @ApiPropertyOptional({ description: 'Include external gateway results', default: true })
  @IsOptional()
  @IsBoolean()
  @TransformBoolean()
  includeExternal?: boolean = true;

  @ApiPropertyOptional({ description: 'Locale hint for gateway-side optimizations (e.g. "en", "de")' })
  @IsOptional()
  @IsString()
  locale?: string;

  // `limit` (capped at 100) and `offset` (bounded by DEFAULT_MAX_OFFSET, default 0)
  // are inherited from CappedPaginationQueryDto — see #17.
}
