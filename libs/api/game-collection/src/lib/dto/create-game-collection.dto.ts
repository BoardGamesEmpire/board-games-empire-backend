import { GameMedium, Visibility } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, Max, Min } from 'class-validator';

export class CreateGameCollectionDto {
  @ApiProperty({ description: 'ID of the PlatformGame to add to the collection' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  platformGameId!: string;

  @ApiProperty({ enum: GameMedium, description: 'Medium of the copy being added (Physical or Digital)' })
  @IsEnum(GameMedium, { message: i18nValidationMessage('validation.isEnum') })
  medium!: GameMedium;

  @ApiPropertyOptional({ description: 'ID of a specific GameRelease of the platform game' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  releaseId?: string;

  @ApiPropertyOptional({ description: 'Number of copies owned', default: 1 })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  quantity?: number;

  @ApiPropertyOptional({ description: 'Personal rating (1-10)' })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(10, { message: i18nValidationMessage('validation.max') })
  rating?: number;

  @ApiPropertyOptional({ description: 'Personal comment about the game' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  comment?: string;

  @ApiPropertyOptional({ description: 'Whether the game is a favorite' })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  favorite?: boolean;

  @ApiPropertyOptional({ description: 'Whether the user would play the game again' })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  playAgain?: boolean;

  @ApiPropertyOptional({
    enum: Visibility,
    description: 'Who may see this collection entry beyond the owner',
    default: Visibility.Private,
  })
  @IsOptional()
  @IsEnum(Visibility, { message: i18nValidationMessage('validation.isEnum') })
  visibility?: Visibility;
}
