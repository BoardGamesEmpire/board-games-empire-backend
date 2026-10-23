import { PlatformType } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { CappedOffsetPaginationQueryDto, NotLessThanProperty, TransformBoolean } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { SEARCHABLE_CONTENT_TYPES, type SearchableContentType } from '../search-filter';

/**
 * The range a publish-year bound can take: the proto carries each as an
 * int32, which would wrap a larger one into some other year (#719).
 */
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/**
 * Converts only a number or a numeric string into a bound, and reads a blank
 * one as absent. Implicit conversion would make a blank string, `false` or
 * `[]` 0 and `true` 1, each a publish year like any other, so a
 * `?publishYearMin=` left empty or a frame's `false` would silently narrow the
 * search from it. Anything else stays as sent, for `@IsInt` to refuse (#719).
 */
const TransformYearBound = () =>
  Transform(({ obj, key, value }) => {
    const raw: unknown = obj[key];
    if (typeof raw === 'string') return raw.trim() === '' ? undefined : value;
    return typeof raw === 'number' ? value : raw;
  });

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
   * The earliest publish year to find, inclusive (#719). A year before the
   * common era is negative. Null, as a frame can send it, doesn't narrow.
   */
  @ApiPropertyOptional({
    description:
      'Earliest publish year to find, inclusive; negative before the common era. Only games published from it ' +
      'are found, so a page can come back shorter than the limit.',
    type: 'integer',
    format: 'int32',
  })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(INT32_MIN, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @Type(() => Number)
  @TransformYearBound()
  publishYearMin?: number | null;

  /** The latest publish year to find, inclusive, and not below the earliest. */
  @ApiPropertyOptional({
    description:
      'Latest publish year to find, inclusive, and not less than publishYearMin. Only games published up to it ' +
      'are found, so a page can come back shorter than the limit.',
    type: 'integer',
    format: 'int32',
  })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(INT32_MIN, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @NotLessThanProperty('publishYearMin')
  @Type(() => Number)
  @TransformYearBound()
  publishYearMax?: number | null;

  /**
   * Whether a publish-year range keeps games with no known year, which it
   * otherwise leaves out. With neither bound given it narrows nothing.
   */
  @ApiPropertyOptional({
    description:
      'Keep games with no known publish year in a publish-year range, which otherwise leaves them out. ' +
      'Without publishYearMin or publishYearMax it changes nothing.',
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @TransformBoolean()
  publishYearIncludeUnknown?: boolean | null;

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
