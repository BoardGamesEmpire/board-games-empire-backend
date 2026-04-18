import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class SearchQueryDto {
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
  @Type(() => Boolean)
  includeLocal?: boolean = true;

  @ApiPropertyOptional({ description: 'Include external gateway results', default: true })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  includeExternal?: boolean = true;

  @ApiPropertyOptional({ description: 'Locale hint for gateway-side optimizations (e.g. "en", "de")' })
  @IsOptional()
  @IsString()
  locale?: string;

  @ApiPropertyOptional({ description: 'Maximum results per gateway', default: 20 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  @Type(() => Number)
  limit?: number;

  @ApiPropertyOptional({ description: 'Offset for pagination', default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Type(() => Number)
  offset?: number;
}
