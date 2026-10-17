import { PlatformType } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { CappedOffsetPaginationQueryDto, TransformBoolean, TransformList } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { SEARCHABLE_CONTENT_TYPES, type SearchableContentType } from '../search-filter';

export class SearchQueryDto extends CappedOffsetPaginationQueryDto(100, 20) {
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
  @TransformList()
  gatewayIds?: string[];

  @ApiPropertyOptional({
    description:
      'Comma-separated platform types. Only games on a platform of one of them are found, ' +
      'so a page can come back shorter than the limit.',
    enum: PlatformType,
    isArray: true,
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsIn(Object.values(PlatformType), { each: true, message: i18nValidationMessage('validation.each.isIn') })
  @TransformList()
  platformTypes?: PlatformType[];

  @ApiPropertyOptional({
    description:
      'Comma-separated content types. Only games of one of them are found, ' +
      'so a page can come back shorter than the limit.',
    enum: SEARCHABLE_CONTENT_TYPES,
    isArray: true,
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsIn(SEARCHABLE_CONTENT_TYPES, { each: true, message: i18nValidationMessage('validation.each.isIn') })
  @TransformList()
  contentTypes?: SearchableContentType[];

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

  // `limit` (capped at 100, local page size 20 when absent) and `offset` (bounded
  // by DEFAULT_MAX_OFFSET, default 0) are inherited from
  // CappedOffsetPaginationQueryDto — see #17 and #403. Search stays
  // offset-native rather than page-based because the value is forwarded to
  // gateways and their upstream vendor APIs unchanged (#230).
}
