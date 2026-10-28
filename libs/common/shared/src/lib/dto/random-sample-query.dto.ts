import { i18nValidationMessage } from '@bge/i18n-core';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsPositive, Max } from 'class-validator';

/** How many games a random sample returns when the caller names no size. */
export const DEFAULT_SAMPLE_SIZE = 10;

/** The most games one random sample returns. */
export const MAX_SAMPLE_SIZE = 50;

/**
 * Query contract for the random game routes, `GET /games/random` and
 * `GET /households/game-pool/random` (#960, #961). `size` carries the
 * validators `limit` does, with the same messages, and a size outside 1–50 is
 * refused rather than clamped.
 */
export class RandomSampleQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_SAMPLE_SIZE,
    default: DEFAULT_SAMPLE_SIZE,
    description: 'How many games to return. Ask again for a different sample.',
  })
  @Type(() => Number)
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  @Max(MAX_SAMPLE_SIZE, { message: i18nValidationMessage('validation.max') })
  @IsOptional()
  size: number = DEFAULT_SAMPLE_SIZE;
}
