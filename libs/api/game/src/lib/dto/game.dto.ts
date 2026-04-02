import type { Game } from '@bge/database';
import { ContentType, TimeMeasure, Visibility } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GameDto
  implements
    Pick<
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
      | 'minPlayTimeMeasure'
      | 'maxPlayTime'
      | 'maxPlayTimeMeasure'
      | 'minAge'
      | 'complexity'
      | 'averageRating'
      | 'ratingsCount'
      | 'ownedByCount'
      | 'visibility'
      | 'contentType'
      | 'createdById'
      | 'createdAt'
      | 'updatedAt'
    >
{
  @ApiProperty({ description: 'Unique game identifier' })
  id!: string;

  @ApiProperty({ description: 'Title of the game' })
  title!: string;

  @ApiPropertyOptional({ description: 'Subtitle of the game', nullable: true })
  subtitle!: string | null;

  @ApiPropertyOptional({ description: 'Long-form description', nullable: true })
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

  @ApiPropertyOptional({ description: 'Minimum play time value', nullable: true })
  minPlayTime!: number | null;

  @ApiPropertyOptional({ enum: TimeMeasure, description: 'Unit for minimum play time', nullable: true })
  minPlayTimeMeasure!: TimeMeasure | null;

  @ApiPropertyOptional({ description: 'Maximum play time value', nullable: true })
  maxPlayTime!: number | null;

  @ApiPropertyOptional({ enum: TimeMeasure, description: 'Unit for maximum play time', nullable: true })
  maxPlayTimeMeasure!: TimeMeasure | null;

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

  @ApiProperty({ enum: Visibility, description: 'Visibility scope of this game record' })
  visibility!: Visibility;

  @ApiProperty({ enum: ContentType, description: 'Content classification (base game, expansion, etc.)' })
  contentType!: ContentType;

  @ApiPropertyOptional({ description: 'ID of the user who created this record', nullable: true })
  createdById!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export class GameListResponseDto {
  @ApiProperty({ type: [GameDto] })
  games!: GameDto[];
}

export class GameResponseDto {
  @ApiProperty({ type: GameDto })
  game!: GameDto;
}

export class GameMessageResponseDto {
  @ApiProperty({ type: GameDto })
  game!: GameDto;

  @ApiProperty({ example: 'Game created successfully' })
  message!: string;
}
