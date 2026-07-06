import { GameMedium, Visibility } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, Max, Min } from 'class-validator';

export class CreateGameCollectionDto {
  @ApiProperty({ description: 'ID of the PlatformGame to add to the collection' })
  @IsString()
  @IsNotEmpty()
  platformGameId!: string;

  @ApiProperty({ enum: GameMedium, description: 'Medium of the copy being added (Physical or Digital)' })
  @IsEnum(GameMedium)
  medium!: GameMedium;

  @ApiPropertyOptional({ description: 'ID of a specific GameRelease of the platform game' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  releaseId?: string;

  @ApiPropertyOptional({ description: 'Number of copies owned', default: 1 })
  @IsOptional()
  @IsInt()
  @IsPositive()
  quantity?: number;

  @ApiPropertyOptional({ description: 'Personal rating (1-10)' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  rating?: number;

  @ApiPropertyOptional({ description: 'Personal comment about the game' })
  @IsOptional()
  @IsString()
  comment?: string;

  @ApiPropertyOptional({ description: 'Whether the game is a favorite' })
  @IsOptional()
  @IsBoolean()
  favorite?: boolean;

  @ApiPropertyOptional({ description: 'Whether the user would play the game again' })
  @IsOptional()
  @IsBoolean()
  playAgain?: boolean;

  @ApiPropertyOptional({
    enum: Visibility,
    description: 'Who may see this collection entry beyond the owner',
    default: Visibility.Private,
  })
  @IsOptional()
  @IsEnum(Visibility)
  visibility?: Visibility;
}
