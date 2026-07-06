import { Visibility } from '@bge/database';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * Standard REST PATCH semantics: omitted fields are preserved, explicit `null`
 * clears a nullable field. `quantity` and `visibility` are non-nullable, so
 * `null` is rejected for them (`@ValidateIf` keeps validation active for
 * `null`, unlike `@IsOptional`, which skips both `null` and `undefined`).
 *
 * Deliberately not writable here:
 * - `platformGameId` / `medium` — identity of the row; add a new entry instead.
 * - `playCount` / `lastPlayed` — server-managed via play tracking.
 */
export class UpdateGameCollectionDto {
  @ApiPropertyOptional({ description: 'Number of copies owned' })
  @ValidateIf((o) => o.quantity !== undefined)
  @IsInt()
  @IsPositive()
  quantity?: number;

  @ApiPropertyOptional({ description: 'Personal rating (1-10); null clears it', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10)
  rating?: number | null;

  @ApiPropertyOptional({ description: 'Personal comment about the game; null clears it', nullable: true })
  @IsOptional()
  @IsString()
  comment?: string | null;

  @ApiPropertyOptional({ description: 'Whether the game is a favorite; null clears it', nullable: true })
  @IsOptional()
  @IsBoolean()
  favorite?: boolean | null;

  @ApiPropertyOptional({ description: 'Whether the user would play the game again; null clears it', nullable: true })
  @IsOptional()
  @IsBoolean()
  playAgain?: boolean | null;

  @ApiPropertyOptional({
    description: 'ID of a specific GameRelease of the platform game; null clears it',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  releaseId?: string | null;

  @ApiPropertyOptional({ enum: Visibility, description: 'Who may see this collection entry beyond the owner' })
  @ValidateIf((o) => o.visibility !== undefined)
  @IsEnum(Visibility)
  visibility?: Visibility;
}
