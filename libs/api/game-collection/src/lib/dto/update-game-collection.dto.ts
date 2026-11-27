import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import type { CollectionReach } from './create-game-collection.dto';
import { CollectionReachProperty } from './create-game-collection.dto';

/**
 * Standard REST PATCH semantics: omitted fields are preserved, explicit `null`
 * clears a nullable field. `reach` is non-nullable, so `null` is rejected for
 * it.
 *
 * Deliberately not writable here:
 * - `platformGameId` / `medium` — identity of the row; add a new entry instead.
 * - `playCount` / `lastPlayed` — server-managed via play tracking.
 * - `quantity` / `releaseId` — the entry's copies hold its edition, and its
 *   quantity is the number of copies it still owns (#1231).
 */
export class UpdateGameCollectionDto {
  @ApiPropertyOptional({ description: 'Personal rating (1-10); null clears it', nullable: true })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(10, { message: i18nValidationMessage('validation.max') })
  rating?: number | null;

  @ApiPropertyOptional({ description: 'Personal comment about the game; null clears it', nullable: true })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  comment?: string | null;

  @ApiPropertyOptional({ description: 'Whether the game is a favorite; null clears it', nullable: true })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  favorite?: boolean | null;

  @ApiPropertyOptional({ description: 'Whether the user would play the game again; null clears it', nullable: true })
  @IsOptional()
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  playAgain?: boolean | null;

  @CollectionReachProperty()
  reach?: CollectionReach;
}
