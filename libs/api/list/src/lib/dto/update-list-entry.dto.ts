import { WishlistPriority } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { LIST_ENTRY_MAX_NOTE_LENGTH } from '../list.constants';
import { WishlistPriorityProperty } from './create-list-entry.dto';

/**
 * Standard REST PATCH semantics: omitted fields are preserved, an explicit
 * `null` clears one.
 *
 * What an entry names (`gameId`, `platformGameId`) is deliberately absent, so
 * the global whitelist pipe refuses it: an entry for another game is a new
 * entry. Its place moves through the reorder route, which renumbers all of a
 * list's entries together (#1241).
 */
export class UpdateListEntryDto {
  @ApiPropertyOptional({
    description: 'Note, in Markdown, stored as written; null clears it',
    nullable: true,
    maxLength: LIST_ENTRY_MAX_NOTE_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(LIST_ENTRY_MAX_NOTE_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  note?: string | null;

  @WishlistPriorityProperty({ nullable: true })
  priority?: WishlistPriority | null;

  @ApiPropertyOptional({
    description:
      'A release of the entry’s platform game; null clears it. An entry that names a game on any platform ' +
      'answers code `LIST_ENTRY_RELEASE_NEEDS_PLATFORM_GAME`, and another platform game’s release code ' +
      '`LIST_ENTRY_RELEASE_MISMATCH`.',
    nullable: true,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  releaseId?: string | null;
}
