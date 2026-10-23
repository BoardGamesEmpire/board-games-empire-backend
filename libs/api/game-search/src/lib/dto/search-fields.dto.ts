import { PlatformType } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { CappedOffsetPaginationQueryDto, TransformBoolean } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsIn, IsOptional, IsString } from 'class-validator';
import { SEARCHABLE_CONTENT_TYPES, type SearchableContentType } from '../search-filter';

/**
 * The fields a game search takes over REST and over the WebSocket, declared
 * once so a rule can't change in one copy alone (#565).
 *
 * Only what both transports read the same way lives here. REST splits its
 * list fields from comma-separated query strings, which a WebSocket frame
 * mustn't accept, so `SearchQueryDto` redeclares those to add the split.
 */
export abstract class SearchFieldsDto extends CappedOffsetPaginationQueryDto(100, 20) {
  @ApiProperty({ description: 'Search query string' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  query!: string;

  /**
   * Gateway IDs to include in the search.
   */
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  gatewayIds?: string[] | null;

  /**
   * Platform types to narrow the search to: only games on a platform of one
   * of them are found, so a page can come back shorter than the limit. Null,
   * which validation lets through as it does a missing list, doesn't narrow.
   */
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsIn(Object.values(PlatformType), { each: true, message: i18nValidationMessage('validation.each.isIn') })
  platformTypes?: PlatformType[] | null;

  /**
   * Content types to narrow the search to: only games of one of them are
   * found, so a page can come back shorter than the limit. Null doesn't
   * narrow either.
   */
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsIn(SEARCHABLE_CONTENT_TYPES, { each: true, message: i18nValidationMessage('validation.each.isIn') })
  contentTypes?: SearchableContentType[] | null;

  /**
   * Whether to include the local DB in the search.
   * Defaults to true — local results are always fast-pathed in parallel.
   */
  @ApiPropertyOptional({ description: 'Include local DB results', default: true })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @TransformBoolean()
  includeLocal?: boolean = true;

  /**
   * Whether to include external sources in the search.
   * Defaults to true — external results are always fast-pathed in parallel.
   */
  @ApiPropertyOptional({ description: 'Include external gateway results', default: true })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @TransformBoolean()
  includeExternal?: boolean = true;

  @ApiPropertyOptional({ description: 'Locale hint for gateway-side optimizations (e.g. "en", "de")' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  locale?: string;
}
