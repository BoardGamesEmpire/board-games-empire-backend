import { ContentType, GameMedium, PlatformType } from '@bge/database';
import { type GameRangeFilter, INT32_MAX, INT32_MIN, TransformRangeBound } from '@bge/game-search';
import { i18nValidationMessage } from '@bge/i18n';
import { DefaultPaginationQueryDto, NotLessThanProperty, TransformBoolean, TransformList } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** The most attendee ids one list may name: as many as the largest page of an event's attendees, and a bound on the `IN` list. */
export const OFFERED_GAMES_MAX_ATTENDEE_IDS = 100;

/** The longest title query, in characters. */
export const OFFERED_GAMES_MAX_QUERY_LENGTH = 200;

/**
 * Which of an event's offered games to list (#1187). Every filter given is
 * ANDed with the others.
 *
 * Each list has an include and an exclude parameter, and both can be given
 * at once. An include keeps the rows matching any value it names; an exclude
 * drops the rows matching any value it names. Each list is comma-separated
 * or repeated, and an empty one is refused rather than read as "none". Each
 * is capped: an attendee list at 100 ids, a typed list at the number of
 * values its type has.
 *
 * The ranges have the game search's names and rules, and read the game's own
 * players, play time and publish year. A range can't be flipped: a one-sided
 * flip is the other bound, as "not 2020 or later" is `publishYearMax=2019`.
 */
export class ListOfferedGamesQueryDto extends DefaultPaginationQueryDto implements GameRangeFilter {
  @ApiPropertyOptional({
    description:
      'Words to find in the game title or subtitle, ignoring case. Every word must appear in one of them. ' +
      '`%` and `_` are matched as themselves. Accents are not folded.',
    maxLength: OFFERED_GAMES_MAX_QUERY_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(OFFERED_GAMES_MAX_QUERY_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  q?: string;

  @ApiPropertyOptional({
    description: 'Comma-separated attendee ids. Only the games these attendees offer are listed.',
    type: String,
    isArray: true,
    maxItems: OFFERED_GAMES_MAX_ATTENDEE_IDS,
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  @ArrayMaxSize(OFFERED_GAMES_MAX_ATTENDEE_IDS, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  @TransformList()
  attendeeIds?: string[];

  @ApiPropertyOptional({
    description:
      "Comma-separated attendee ids. The games these attendees offer are left out, so your own attendee id lists everyone's games but yours.",
    type: String,
    isArray: true,
    maxItems: OFFERED_GAMES_MAX_ATTENDEE_IDS,
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  @ArrayMaxSize(OFFERED_GAMES_MAX_ATTENDEE_IDS, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  @TransformList()
  excludeAttendeeIds?: string[];

  @ApiPropertyOptional({
    description:
      'Comma-separated platform types. Only games offered on a platform of one of these types are listed: the ' +
      "offered copy's platform, not every platform the game is on.",
    enum: PlatformType,
    enumName: 'PlatformType',
    isArray: true,
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  @ArrayMaxSize(Object.values(PlatformType).length, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @IsIn(Object.values(PlatformType), { each: true, message: i18nValidationMessage('validation.each.isIn') })
  @TransformList()
  platformTypes?: PlatformType[];

  @ApiPropertyOptional({
    description:
      "Comma-separated platform types. Games offered on a platform of one of these types are left out, by the offered copy's platform.",
    enum: PlatformType,
    enumName: 'PlatformType',
    isArray: true,
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  @ArrayMaxSize(Object.values(PlatformType).length, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @IsIn(Object.values(PlatformType), { each: true, message: i18nValidationMessage('validation.each.isIn') })
  @TransformList()
  excludePlatformTypes?: PlatformType[];

  @ApiPropertyOptional({
    description: 'Comma-separated mediums. Only copies of these mediums are listed.',
    enum: GameMedium,
    enumName: 'GameMedium',
    isArray: true,
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  @ArrayMaxSize(Object.values(GameMedium).length, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @IsIn(Object.values(GameMedium), { each: true, message: i18nValidationMessage('validation.each.isIn') })
  @TransformList()
  mediums?: GameMedium[];

  @ApiPropertyOptional({
    description: 'Comma-separated mediums. Copies of these mediums are left out.',
    enum: GameMedium,
    enumName: 'GameMedium',
    isArray: true,
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  @ArrayMaxSize(Object.values(GameMedium).length, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @IsIn(Object.values(GameMedium), { each: true, message: i18nValidationMessage('validation.each.isIn') })
  @TransformList()
  excludeMediums?: GameMedium[];

  @ApiPropertyOptional({
    description: 'Comma-separated content types. Only games of these types are listed.',
    enum: ContentType,
    enumName: 'ContentType',
    isArray: true,
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  @ArrayMaxSize(Object.values(ContentType).length, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @IsIn(Object.values(ContentType), { each: true, message: i18nValidationMessage('validation.each.isIn') })
  @TransformList()
  contentTypes?: ContentType[];

  @ApiPropertyOptional({
    description: 'Comma-separated content types. Games of these types are left out.',
    enum: ContentType,
    enumName: 'ContentType',
    isArray: true,
  })
  @IsOptional()
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayNotEmpty({ message: i18nValidationMessage('validation.arrayNotEmpty') })
  @ArrayMaxSize(Object.values(ContentType).length, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @IsIn(Object.values(ContentType), { each: true, message: i18nValidationMessage('validation.each.isIn') })
  @TransformList()
  excludeContentTypes?: ContentType[];

  @ApiPropertyOptional({
    description:
      'Earliest publish year, inclusive; negative before the common era. Only games published from it are listed.',
    type: 'integer',
    format: 'int32',
  })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(INT32_MIN, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @Type(() => Number)
  @TransformRangeBound()
  publishYearMin?: number;

  @ApiPropertyOptional({
    description:
      'Latest publish year, inclusive, and not less than publishYearMin. Only games published up to it are listed.',
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
  publishYearMax?: number;

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
  publishYearIncludeUnknown?: boolean;

  @ApiPropertyOptional({
    description:
      'Fewest players, at least 1. Only games that support every player count from playerCountMin to ' +
      'playerCountMax are listed, and either alone is one count, so playerCountMin=5 lists games for 5 players.',
    type: 'integer',
    format: 'int32',
  })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @Type(() => Number)
  @TransformRangeBound()
  playerCountMin?: number;

  @ApiPropertyOptional({
    description:
      'Most players, not less than playerCountMin. Only games that support every player count from ' +
      'playerCountMin to playerCountMax are listed, and either alone is one count.',
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
  playerCountMax?: number;

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
  playerCountIncludeUnknown?: boolean;

  @ApiPropertyOptional({
    description:
      'Shortest play time, in minutes, inclusive. Only games whose whole play time is at least this long are ' +
      'listed, and a game with one play time takes that long.',
    type: 'integer',
    format: 'int32',
  })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(0, { message: i18nValidationMessage('validation.min') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @Type(() => Number)
  @TransformRangeBound()
  playTimeMin?: number;

  @ApiPropertyOptional({
    description:
      'Longest play time, in minutes, inclusive, and not less than playTimeMin. Only games whose whole play ' +
      'time fits within it are listed, and a game with one play time takes that long.',
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
  playTimeMax?: number;

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
  playTimeIncludeUnknown?: boolean;
}
