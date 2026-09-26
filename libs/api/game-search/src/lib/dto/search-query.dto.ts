import { i18nValidationMessage } from '@bge/i18n';
import { CappedOffsetPaginationQueryDto, TransformBoolean } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsBoolean, IsOptional, IsString } from 'class-validator';

export class SearchQueryDto extends CappedOffsetPaginationQueryDto(100) {
  @ApiProperty({ description: 'Search query string' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  query!: string;

  @ApiPropertyOptional({
    description: 'Comma-separated gateway IDs to include. Empty = all active gateways.',
    type: String,
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  @Transform(({ value }) => (typeof value === 'string' ? value.split(',').filter(Boolean) : value))
  gatewayIds?: string[];

  @ApiPropertyOptional({ description: 'Include local DB results', default: true })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @TransformBoolean()
  includeLocal?: boolean = true;

  @ApiPropertyOptional({ description: 'Include external gateway results', default: true })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @TransformBoolean()
  includeExternal?: boolean = true;

  @ApiPropertyOptional({ description: 'Locale hint for gateway-side optimizations (e.g. "en", "de")' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  locale?: string;

  // `limit` (capped at 100) and `offset` (bounded by DEFAULT_MAX_OFFSET, default 0)
  // are inherited from CappedOffsetPaginationQueryDto — see #17. Search stays
  // offset-native rather than page-based because the value is forwarded to
  // gateways and their upstream vendor APIs unchanged (D-230-5 on #230).
}
