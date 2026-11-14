import { i18nValidationMessage } from '@bge/i18n';
import { TransformTrim } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { LIST_MAX_DESCRIPTION_LENGTH, LIST_MAX_NAME_LENGTH } from '../list.constants';
import { ListReachProperty, type ListReach } from './create-list.dto';

/**
 * Standard REST PATCH semantics: omitted fields are preserved, an explicit
 * `null` clears `name` or `description`. A custom list refuses a null name
 * (`LIST_NAME_REQUIRED`); a wishlist takes it and is shown under its client's
 * own name.
 *
 * `kind` and `position` are deliberately absent, so the global whitelist pipe
 * refuses a body naming either with 400. A list's kind never changes, and its
 * place moves through the reorder route, which renumbers all of a user's lists
 * together (#1241).
 */
export class UpdateListDto {
  @ApiPropertyOptional({
    description: 'List name; null clears it, which only a wishlist accepts',
    nullable: true,
    maxLength: LIST_MAX_NAME_LENGTH,
  })
  @TransformTrim()
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(LIST_MAX_NAME_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  name?: string | null;

  @ApiPropertyOptional({
    description: 'Description, in Markdown; null clears it',
    nullable: true,
    maxLength: LIST_MAX_DESCRIPTION_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(LIST_MAX_DESCRIPTION_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  description?: string | null;

  @ListReachProperty()
  reach?: ListReach;
}
