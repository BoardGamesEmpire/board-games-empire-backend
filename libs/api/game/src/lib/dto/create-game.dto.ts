import { TimeMeasure, Visibility } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsPositive, IsString } from 'class-validator';

export class CreateGameDto {
  @ApiProperty({ description: 'Title of the game' })
  @IsString()
  title!: string;

  @ApiPropertyOptional({ description: 'Subtitle of the game' })
  @IsOptional()
  @IsString()
  subtitle?: string;

  @ApiPropertyOptional({ description: 'Description of the game' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ description: 'URL to an image representing the game' })
  @IsOptional()
  @IsString()
  image?: string;

  @ApiPropertyOptional({ description: 'URL to a thumbnail image for the game' })
  @IsOptional()
  @IsString()
  thumbnail?: string;

  @ApiPropertyOptional({ description: 'Year the game was published' })
  @IsOptional()
  @IsPositive()
  publishYear?: number;

  @ApiPropertyOptional({ description: 'Minimum number of players for the game' })
  @IsOptional()
  @IsPositive()
  minPlayers?: number;

  @ApiPropertyOptional({ description: 'Maximum number of players for the game' })
  @IsOptional()
  @IsPositive()
  maxPlayers?: number;

  @ApiPropertyOptional({ description: 'Estimated play time for the game' })
  @IsOptional()
  @IsPositive()
  playingTime?: number;

  @ApiPropertyOptional({ description: 'Minimum play time for the game' })
  @IsOptional()
  @IsPositive()
  minPlayTime?: number;

  @ApiPropertyOptional({
    enum: TimeMeasure,
    description: 'Unit of measure for minimum play time (e.g. minutes, hours)',
  })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(TimeMeasure))
  minPlayTimeMeasure?: TimeMeasure;

  @ApiPropertyOptional({ description: 'Maximum play time for the game' })
  @IsOptional()
  @IsPositive()
  maxPlayTime?: number;

  @ApiPropertyOptional({
    enum: TimeMeasure,
    description: 'Unit of measure for maximum play time (e.g. minutes, hours)',
  })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(TimeMeasure))
  maxPlayTimeMeasure?: TimeMeasure;

  @ApiPropertyOptional({ description: 'Minimum age recommended for the game' })
  @IsOptional()
  @IsPositive()
  minAge?: number;

  @ApiPropertyOptional({ description: 'Complexity rating for the game (e.g. 1-5)' })
  @IsOptional()
  @IsPositive()
  complexity?: number;

  @ApiPropertyOptional({
    enum: Visibility,
    description: 'Indicates whether the game is visible to other users',
  })
  @IsOptional()
  @IsString()
  @IsIn(Object.values(Visibility))
  visible?: Visibility;
}
