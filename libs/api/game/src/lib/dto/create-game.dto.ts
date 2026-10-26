import { Reach } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { NotLessThanProperty, ReachProperty } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsPositive, IsString, Max } from 'class-validator';

const GAME_REACHES = [Reach.Public, Reach.FriendsOfFriends, Reach.Friends, Reach.Private] as const;

/**
 * The longest new or changed description a game may be sent with. The
 * server sanitizes it within the request, and even text kept as plain text
 * takes time in proportion to its length: up to 3 µs a character, 0.8 s at
 * the body limit. At this cap the slowest input found takes about 70 ms.
 *
 * The game service holds a description to it, not validation, as a game may
 * already have a longer one, from an import, and a client sending that back
 * unchanged isn't refused.
 */
export const GAME_DESCRIPTION_MAX_LENGTH = 20_000;
export type GameReach = (typeof GAME_REACHES)[number];

/** The largest value an integer column holds; above it, Prisma's write fails as a 500, not a 400. */
const INT32_MAX = 2 ** 31 - 1;

/**
 * A game's reach: every rung a game read rule serves, friends of friends
 * included (#496). Shared with `UpdateGameDto`, which names no default.
 */
export function GameReachProperty(defaultReach?: GameReach): PropertyDecorator {
  return ReachProperty({
    reaches: GAME_REACHES,
    default: defaultReach,
    description:
      'Who may read the game besides its creator. `Public`: every signed-in user. `FriendsOfFriends`: the ' +
      "creator's friends and friends of friends, unless a block stands between the creator and the reader. " +
      "`Friends`: the creator's friends. `Private`: no one.",
  });
}

export class CreateGameDto {
  @ApiProperty({ description: 'Title of the game' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  title!: string;

  @ApiPropertyOptional({ description: 'Subtitle of the game' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  subtitle?: string;

  @ApiPropertyOptional({
    description:
      'Description of the game, in Markdown. Raw HTML is removed, and a link that is not http, https or mailto is ' +
      `reduced to its text. A new or changed description may be at most ${GAME_DESCRIPTION_MAX_LENGTH} characters; ` +
      'the one a game already has is accepted unchanged, however long.',
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  description?: string;

  @ApiPropertyOptional({ description: 'URL to an image representing the game' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  image?: string;

  @ApiPropertyOptional({ description: 'URL to a thumbnail image for the game' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  thumbnail?: string;

  @ApiPropertyOptional({ description: 'Year the game was published' })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  publishYear?: number;

  @ApiPropertyOptional({ description: 'Minimum number of players for the game' })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  minPlayers?: number;

  @ApiPropertyOptional({ description: 'Maximum number of players for the game' })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @NotLessThanProperty('minPlayers')
  maxPlayers?: number;

  @ApiPropertyOptional({
    description: 'Minimum play time for the game, in minutes; a client shows it in hours and minutes',
  })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  minPlayTime?: number;

  @ApiPropertyOptional({
    description: 'Maximum play time for the game, in minutes; a client shows it in hours and minutes',
  })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  @NotLessThanProperty('minPlayTime')
  maxPlayTime?: number;

  @ApiPropertyOptional({ description: 'Minimum age recommended for the game' })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  @Max(INT32_MAX, { message: i18nValidationMessage('validation.max') })
  minAge?: number;

  @ApiPropertyOptional({ description: 'Complexity rating for the game (e.g. 1-5)' })
  @IsOptional()
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  complexity?: number;

  @GameReachProperty(Reach.Public)
  reach?: GameReach;
}
