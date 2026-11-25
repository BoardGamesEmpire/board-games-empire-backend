import { i18nValidationMessage } from '@bge/i18n';
import { TransformAsSent } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, NotContains, ValidateIf } from 'class-validator';
import type { RequestedScope } from '../key-scope-request';

/**
 * Longer than any slug the permission catalog holds or any id the server
 * mints, so a real key scope always fits; the bound keeps a body of hundreds of
 * key scopes from carrying strings of any size (#1418).
 */
export const REQUESTED_SCOPE_MAX_LENGTH = 128;

/**
 * One key scope a create or edit names (#1418): a permission's slug, and a
 * row to pin it to. The server takes the resource type from the permission,
 * so a request never names one, and the global pipe refuses any other key.
 */
export class RequestedScopeDto implements RequestedScope {
  @ApiProperty({
    description:
      "The permission's stable name, such as read:game, as GET /api/api-keys/grantable lists it. One the catalog " +
      'lacks, or one you may not hand a key, is refused.',
    minLength: 1,
    maxLength: REQUESTED_SCOPE_MAX_LENGTH,
  })
  @TransformAsSent()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(REQUESTED_SCOPE_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  @NotContains('\u0000', { message: i18nValidationMessage('validation.noNullCharacter') })
  slug!: string;

  @ApiPropertyOptional({
    description:
      'The one record the key scope reaches, by id. Left out, the key scope reaches every record your own ' +
      'permissions reach. Only a permission whose grantable entry says pinnable takes one. An empty id is ' +
      'refused: leave it out for no pin.',
    minLength: 1,
    maxLength: REQUESTED_SCOPE_MAX_LENGTH,
  })
  @TransformAsSent()
  @ValidateIf((_, value) => value !== undefined)
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(REQUESTED_SCOPE_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  @NotContains('\u0000', { message: i18nValidationMessage('validation.noNullCharacter') })
  resourceId?: string;
}
