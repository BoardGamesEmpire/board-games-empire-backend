import { GameMedium, Reach } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ReachProperty } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsPositive, IsString, Max, Min } from 'class-validator';

const COLLECTION_REACHES = [Reach.Private, Reach.Friends, Reach.Public] as const;
export type CollectionReach = (typeof COLLECTION_REACHES)[number];

/**
 * A collection entry's reach: every rung a collection read rule serves.
 * `FriendsOfFriends` waits on #496, which defines friends of friends. The
 * owner's households see the entry whatever its reach (#495). Shared with
 * `UpdateGameCollectionDto`, which names no default.
 */
export function CollectionReachProperty(defaultReach?: CollectionReach): PropertyDecorator {
  return ReachProperty({
    reaches: COLLECTION_REACHES,
    default: defaultReach,
    description:
      'Who may see this entry besides its owner and the households they share their games with. `Private`: ' +
      "no one. `Friends`: the owner's friends, unless the owner hides their collection from friends. " +
      '`Public`: everyone on the server, guests included.',
  });
}

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

  @CollectionReachProperty(Reach.Private)
  reach?: CollectionReach;
}
