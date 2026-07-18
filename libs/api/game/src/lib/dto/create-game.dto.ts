import { TimeMeasure, Visibility } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsPositive, IsString } from 'class-validator';

export class CreateGameDto {
  @ApiProperty({ description: 'Title of the game' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  title!: string;

  @ApiPropertyOptional({ description: 'Subtitle of the game' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  subtitle?: string;

  @ApiPropertyOptional({ description: 'Description of the game' })
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
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  publishYear?: number;

  @ApiPropertyOptional({ description: 'Minimum number of players for the game' })
  @IsOptional()
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  minPlayers?: number;

  @ApiPropertyOptional({ description: 'Maximum number of players for the game' })
  @IsOptional()
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  maxPlayers?: number;

  @ApiPropertyOptional({ description: 'Estimated play time for the game' })
  @IsOptional()
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  playingTime?: number;

  @ApiPropertyOptional({ description: 'Minimum play time for the game' })
  @IsOptional()
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  minPlayTime?: number;

  @ApiPropertyOptional({
    enum: TimeMeasure,
    description: 'Unit of measure for minimum play time (e.g. minutes, hours)',
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsIn(Object.values(TimeMeasure), { message: i18nValidationMessage('validation.isIn') })
  minPlayTimeMeasure?: TimeMeasure;

  @ApiPropertyOptional({ description: 'Maximum play time for the game' })
  @IsOptional()
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  maxPlayTime?: number;

  @ApiPropertyOptional({
    enum: TimeMeasure,
    description: 'Unit of measure for maximum play time (e.g. minutes, hours)',
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsIn(Object.values(TimeMeasure), { message: i18nValidationMessage('validation.isIn') })
  maxPlayTimeMeasure?: TimeMeasure;

  @ApiPropertyOptional({ description: 'Minimum age recommended for the game' })
  @IsOptional()
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  minAge?: number;

  @ApiPropertyOptional({ description: 'Complexity rating for the game (e.g. 1-5)' })
  @IsOptional()
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  complexity?: number;

  @ApiPropertyOptional({
    enum: Visibility,
    description: 'Indicates whether the game is visible to other users',
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsIn(Object.values(Visibility), { message: i18nValidationMessage('validation.isIn') })
  visible?: Visibility;
}
