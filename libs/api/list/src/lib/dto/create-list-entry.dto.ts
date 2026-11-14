import { WishlistPriority } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { LIST_ENTRY_MAX_NOTE_LENGTH } from '../list.constants';

/**
 * A list entry's wishlist priority. Shared with `UpdateListEntryDto`, which
 * also takes `null` to clear it.
 */
export function WishlistPriorityProperty({ nullable = false } = {}): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({
      enum: WishlistPriority,
      enumName: 'WishlistPriority',
      nullable,
      description:
        'How much the user wants the game, in BoardGameGeek’s five steps from `MustHave` to `DontBuy`. Only a ' +
        'wishlist’s entries take one; any other list answers code `LIST_PRIORITY_WISHLIST_ONLY`.' +
        (nullable ? ' Null clears it.' : ''),
    }),
    IsOptional(),
    IsEnum(WishlistPriority, { message: i18nValidationMessage('validation.isEnum') }),
  );
}

/**
 * A new entry names a game on any platform (`gameId`) or one platform game
 * (`platformGameId`), never both and never neither: the service answers
 * `LIST_ENTRY_ONE_TARGET` otherwise (#1241). A release needs the platform game
 * it belongs to.
 */
export class CreateListEntryDto {
  @ApiPropertyOptional({
    description: 'A game, on any platform. Give this or `platformGameId`, not both.',
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  gameId?: string;

  @ApiPropertyOptional({
    description: 'One game on one platform. Give this or `gameId`, not both.',
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  platformGameId?: string;

  @ApiPropertyOptional({
    description:
      'A release of the platform game. Only with `platformGameId` (code `LIST_ENTRY_RELEASE_NEEDS_PLATFORM_GAME`), ' +
      'and only one of its own releases (code `LIST_ENTRY_RELEASE_MISMATCH`).',
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  releaseId?: string;

  @ApiPropertyOptional({ description: 'Note, in Markdown, stored as written', maxLength: LIST_ENTRY_MAX_NOTE_LENGTH })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(LIST_ENTRY_MAX_NOTE_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  note?: string;

  @WishlistPriorityProperty()
  priority?: WishlistPriority;
}
