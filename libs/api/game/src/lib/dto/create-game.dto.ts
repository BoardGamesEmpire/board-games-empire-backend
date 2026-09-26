import { TimeMeasure, Visibility } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsPositive, IsString, ValidateIf } from 'class-validator';

const GAME_VISIBILITIES = [Visibility.Public, Visibility.Private] as const;
export type GameVisibility = (typeof GAME_VISIBILITIES)[number];

/**
 * A game's visibility: Public or Private only. The other tiers name audiences
 * no game read rule serves yet, so a game saved with one would be its
 * creator's alone while claiming otherwise; they arrive with #495's reach
 * rules.
 *
 * `ValidateIf` rather than `IsOptional`, which skips null as well as
 * undefined: left out, the column default applies, but an explicit null is
 * refused here instead of reaching a non-nullable column as a 500. Shared with
 * `UpdateGameDto`, which declares the field itself because `PartialType` would
 * add `IsOptional` back.
 */
export function GameVisibilityProperty(): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({
      enum: GAME_VISIBILITIES,
      description: 'Public games are visible to everyone; private games only to their creator',
    }),
    ValidateIf((_, value) => value !== undefined),
    IsString({ message: i18nValidationMessage('validation.isString') }),
    IsIn(GAME_VISIBILITIES, { message: i18nValidationMessage('validation.isIn') }),
  );
}

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

  @GameVisibilityProperty()
  visibility?: GameVisibility;
}
