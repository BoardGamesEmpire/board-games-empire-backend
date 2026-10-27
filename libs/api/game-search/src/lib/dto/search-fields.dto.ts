import { PlatformType } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { CappedOffsetPaginationQueryDto, NotLessThanProperty, TransformBoolean } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { SEARCHABLE_CONTENT_TYPES, type SearchableContentType } from '../search-filter';

/**
 * The range a search filter's bound can take: the proto carries each as an
 * int32, which would wrap a larger one into some other value (#719, #869).
 */
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

/**
 * Converts only a number or a numeric string into a range's bound, and reads
 * a blank one as absent. Implicit conversion would make a blank string,
 * `false` or `[]` 0 and `true` 1, each a bound like any other, so a
 * `?publishYearMin=` or `?playTimeMax=` left empty, or a frame's `false`,
 * would silently narrow the search by it. Anything else stays as sent, for
 * `@IsInt` to refuse (#719, #869).
 */
const TransformRangeBound = () =>
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
  @TransformRangeBound()
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
  @TransformRangeBound()
  publishYearMax?: number | null;

  /**
   * Whether a publish-year range keeps games with no known year, which it
   * otherwise leaves out. With neither bound given it narrows nothing.
   */
  @ApiPropertyOptional({
    description:
      'Keep games with no known publish year in a publish-year range, which otherwise leaves them out. ' +
      'Without publishYearMin or publishYearMax it changes nothing.',
    type: Boolean,
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @TransformBoolean()
  publishYearIncludeUnknown?: boolean | null;

  /**
   * The fewest players a game must support, at least 1 (#869). A game is
   * found when it supports every count from this to `playerCountMax`, and a
   * bound alone is that one count. Null doesn't narrow.
   */
  @ApiPropertyOptional({
    description:
      'Fewest players, at least 1. Only games that support every player count from playerCountMin to ' +
      'playerCountMax are found, and either alone is one count, so playerCountMin=5 finds games for 5 players. ' +
      'A page can come back shorter than the limit.',
    type: 'integer',
    format: 'int32',
  })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @Type(() => Number)
  @TransformRangeBound()
  playerCountMin?: number | null;

  /** The most players a game must support, and not below the fewest. */
  @ApiPropertyOptional({
    description:
      'Most players, not less than playerCountMin. Only games that support every player count from ' +
      'playerCountMin to playerCountMax are found, and either alone is one count, so playerCountMax=4 finds ' +
      'games for 4 players. A page can come back shorter than the limit.',
    type: 'integer',
    format: 'int32',
  })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @NotLessThanProperty('playerCountMin')
  @Type(() => Number)
  @TransformRangeBound()
  playerCountMax?: number | null;

  /**
   * Whether a player-count range keeps games missing either player count,
   * which it otherwise leaves out. With neither bound given it narrows nothing.
   */
  @ApiPropertyOptional({
    description:
      'Keep games missing either player count in a player-count range, which otherwise leaves them out. ' +
      'Without playerCountMin or playerCountMax it changes nothing.',
    type: Boolean,
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @TransformBoolean()
  playerCountIncludeUnknown?: boolean | null;

  /**
   * The shortest play time to find, in minutes, inclusive (#869). A game is
   * found when its whole play time is at least this long, and a game with
   * one play time takes that long. Null doesn't narrow.
   */
  @ApiPropertyOptional({
    description:
      'Shortest play time to find, in minutes, inclusive. Only games whose whole play time is at least this ' +
      'long are found, and a game with one play time takes that long. A page can come back shorter than the limit.',
    type: 'integer',
    format: 'int32',
  })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(0, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @Type(() => Number)
  @TransformRangeBound()
  playTimeMin?: number | null;

  /** The longest play time to find, in minutes, inclusive, and not below the shortest. */
  @ApiPropertyOptional({
    description:
      'Longest play time to find, in minutes, inclusive, and not less than playTimeMin. Only games whose whole ' +
      'play time fits within it are found, and a game with one play time takes that long. A page can come back ' +
      'shorter than the limit.',
    type: 'integer',
    format: 'int32',
  })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(0, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @NotLessThanProperty('playTimeMin')
  @Type(() => Number)
  @TransformRangeBound()
  playTimeMax?: number | null;

  /**
   * Whether a play-time range keeps games with no known play time, which it
   * otherwise leaves out. With neither bound given it narrows nothing.
   */
  @ApiPropertyOptional({
    description:
      'Keep games with no known play time in a play-time range, which otherwise leaves them out. ' +
      'Without playTimeMin or playTimeMax it changes nothing.',
    type: Boolean,
    default: false,
  })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @TransformBoolean()
  playTimeIncludeUnknown?: boolean | null;

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
