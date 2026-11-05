import type { ExpansionLink, Game } from '@bge/database';
import { ContentType, PlatformType, Reach } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { LinkedGame } from '../linked-game.select';
import type { PlatformGameDetail } from '../platform-game-detail.select';

export class GameDto implements Pick<
  Game,
  | 'id'
  | 'title'
  | 'subtitle'
  | 'description'
  | 'image'
  | 'thumbnail'
  | 'publishYear'
  | 'minPlayers'
  | 'maxPlayers'
  | 'minPlayTime'
  | 'maxPlayTime'
  | 'minAge'
  | 'complexity'
  | 'averageRating'
  | 'ratingsCount'
  | 'ownedByCount'
  | 'reach'
  | 'contentType'
  | 'createdById'
  | 'createdAt'
  | 'updatedAt'
> {
  @ApiProperty({ description: 'Unique game identifier' })
  id!: string;

  @ApiProperty({ description: 'Title of the game' })
  title!: string;

  @ApiPropertyOptional({ description: 'Subtitle of the game', nullable: true })
  subtitle!: string | null;

  @ApiPropertyOptional({
    description: 'Long-form description, in Markdown. Render it with raw HTML turned off.',
    nullable: true,
  })
  description!: string | null;

  @ApiPropertyOptional({ description: 'Full image URL', nullable: true })
  image!: string | null;

  @ApiPropertyOptional({ description: 'Thumbnail image URL', nullable: true })
  thumbnail!: string | null;

  @ApiPropertyOptional({ description: 'Year the game was published', nullable: true })
  publishYear!: number | null;

  @ApiPropertyOptional({ description: 'Minimum number of players', nullable: true })
  minPlayers!: number | null;

  @ApiPropertyOptional({ description: 'Maximum number of players', nullable: true })
  maxPlayers!: number | null;

  @ApiPropertyOptional({ description: 'Minimum play time, in minutes', nullable: true })
  minPlayTime!: number | null;

  @ApiPropertyOptional({ description: 'Maximum play time, in minutes', nullable: true })
  maxPlayTime!: number | null;

  @ApiPropertyOptional({ description: 'Minimum recommended player age', nullable: true })
  minAge!: number | null;

  @ApiPropertyOptional({ description: 'Complexity rating (1–5)', nullable: true })
  complexity!: number | null;

  @ApiPropertyOptional({ description: 'Average community rating', nullable: true })
  averageRating!: number | null;

  @ApiPropertyOptional({ description: 'Number of community ratings', nullable: true })
  ratingsCount!: number | null;

  @ApiProperty({ description: 'Number of users who own this game' })
  ownedByCount!: number;

  @ApiProperty({ enum: Reach, enumName: 'Reach', description: 'Who may read the game besides its creator' })
  reach!: Reach;

  @ApiProperty({ enum: ContentType, description: 'Content classification (base game, expansion, etc.)' })
  contentType!: ContentType;

  @ApiPropertyOptional({ description: 'ID of the user who created this record', nullable: true })
  createdById!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

/**
 * One expansion link, seen from the game at one end (#1069): `gameId` names
 * the game at the other end. The value is the link's own, since an expansion
 * can be standalone for one base game and not another.
 */
export class ExpansionLinkDto implements ExpansionLink {
  @ApiProperty({ description: 'ID of the game at the other end of the link' })
  gameId!: string;

  @ApiProperty({ description: 'Whether the expansion plays without this base game' })
  isStandalone!: boolean;
}

/** A row of `GET /games` (#1069). */
export class GameListItemDto extends GameDto {
  @ApiProperty({
    type: [ExpansionLinkDto],
    description:
      'For an expansion, the base games it attaches to that this list also contains, in title order, then game ' +
      'id, each with that link’s `isStandalone`. Empty for any other game.',
  })
  baseGames!: ExpansionLinkDto[];
}

export class GamePlatformDto {
  @ApiProperty({ description: 'Unique platform identifier' })
  id!: string;

  @ApiProperty({ description: 'Name of the platform' })
  name!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Short name of the platform' })
  abbreviation!: string | null;

  @ApiProperty({ enum: PlatformType, enumName: 'PlatformType', description: 'Kind of platform' })
  platformType!: PlatformType;
}

/**
 * A game on one platform (#791). This class implements the read's row type and
 * the service annotates that read with this class, so a column missing from
 * either the select or this class fails the typecheck.
 */
export class PlatformGameDetailDto implements PlatformGameDetail {
  @ApiProperty({ description: 'Unique platform game identifier, which `POST /game-collections` takes' })
  id!: string;

  @ApiProperty({ description: 'ID of the game this is a platform game of' })
  gameId!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Full image URL. Null means use the game’s.' })
  image!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'Thumbnail image URL. Null means use the game’s.' })
  thumbnail!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Minimum number of players. Null means use the game’s.' })
  minPlayers!: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Maximum number of players. Null means use the game’s.' })
  maxPlayers!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Minimum play time, in minutes. Null means use the game’s.',
  })
  minPlayTime!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Maximum play time, in minutes. Null means use the game’s.',
  })
  maxPlayTime!: number | null;

  @ApiProperty({ description: 'Whether one person can play it alone' })
  supportsSolo!: boolean;

  @ApiProperty({ description: 'Whether people can play it together in one place' })
  supportsLocal!: boolean;

  @ApiProperty({ description: 'Whether people can play it together online' })
  supportsOnline!: boolean;

  @ApiProperty({ description: 'Whether players can take their turns at different times' })
  hasAsyncPlay!: boolean;

  @ApiProperty({ description: 'Whether players act at the same time' })
  hasRealtime!: boolean;

  @ApiProperty({ description: 'Whether it includes a tutorial' })
  hasTutorial!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: GamePlatformDto })
  platform!: GamePlatformDto;
}

/**
 * The game at the far end of an expansion link (#1069). This class implements
 * the read's row type and the service annotates that read with this class, so
 * a column missing from either the select or this class fails the typecheck.
 */
export class LinkedGameDto implements LinkedGame {
  @ApiProperty({ description: 'Unique game identifier' })
  id!: string;

  @ApiProperty({ description: 'Title of the game' })
  title!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Thumbnail image URL. The title labels it.' })
  thumbnail!: string | null;

  @ApiProperty({
    enum: ContentType,
    enumName: 'ContentType',
    description: 'Content classification (base game, expansion, etc.)',
  })
  contentType!: ContentType;
}

/** One of a game's expansions on `GET /games/:id` (#1069). */
export class LinkedExpansionDto extends ExpansionLinkDto {
  @ApiProperty({ type: LinkedGameDto, description: 'The expansion' })
  game!: LinkedGameDto;

  @ApiProperty({
    type: [String],
    description:
      'IDs of the platforms the expansion has a platform game on, in platform name order. Empty when it has ' +
      'none, or when the actor may not read its platform games, such as an API key with no `read:platform_game`.',
  })
  platformIds!: string[];
}

/** One of an expansion's base games on `GET /games/:id` (#1069). */
export class LinkedBaseGameDto extends ExpansionLinkDto {
  @ApiProperty({ type: LinkedGameDto, description: 'The base game' })
  game!: LinkedGameDto;
}

export class GameDetailDto extends GameDto {
  @ApiProperty({
    type: [PlatformGameDetailDto],
    description:
      'The platform games the actor may read, in platform name order. Empty when the game has no platform, or ' +
      'when the actor may not read them.',
  })
  platformGames!: PlatformGameDetailDto[];

  @ApiProperty({
    type: [LinkedExpansionDto],
    description:
      'The game’s expansions the actor may read, in title order, then game id. Each link carries its own ' +
      '`isStandalone`.',
  })
  expansions!: LinkedExpansionDto[];

  @ApiProperty({
    type: [LinkedBaseGameDto],
    description:
      'For an expansion, the base games it attaches to that the actor may read, in title order, then game id. ' +
      'Each link carries its own `isStandalone`. Empty for any other game.',
  })
  baseGames!: LinkedBaseGameDto[];
}

export class GameResponseDto {
  @ApiProperty({ type: GameDetailDto })
  game!: GameDetailDto;
}

export class GameMessageResponseDto {
  @ApiProperty({ type: GameDto })
  game!: GameDto;

  @ApiProperty({ example: 'Game created successfully' })
  message!: string;
}
