import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { EXCLUDED_GAME_MAX_REASON_LENGTH } from '../constants/household.constants';

/**
 * `POST /households/:householdId/members/me/excluded-games` (#170): holds one
 * of the caller's collection entries back from this household's game pool. A
 * repeat for the same entry that sends a reason replaces it, one that sends it
 * `null` or blank clears it, and one that leaves it out keeps it.
 */
export class ExcludeGameDto {
  @ApiProperty({ description: 'ID of one of your own collection entries.' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  collectionEntryId!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Why you hold it back: a note only you see. It is never sent in a webhook. Trimmed. Sending the same entry again with a reason replaces it, sending it blank or null clears it, and leaving it out keeps the stored reason.',
    maxLength: EXCLUDED_GAME_MAX_REASON_LENGTH,
  })
  @IsOptional()
  // Read as sent, so implicit conversion can't store a number as text; then
  // trimmed, with a reason of only spaces read as none (#170).
  @Transform(({ obj, key }: { key: string; obj: Record<string, unknown> }) => {
    const sent = obj[key];

    return typeof sent === 'string' ? sent.trim() || null : sent;
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(EXCLUDED_GAME_MAX_REASON_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  reason?: string | null;
}
