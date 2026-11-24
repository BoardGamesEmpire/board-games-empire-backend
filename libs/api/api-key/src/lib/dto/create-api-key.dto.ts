import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  MaxLength,
  MinLength,
  NotContains,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import {
  API_KEY_EXPIRY_DEFAULT_DAYS,
  API_KEY_EXPIRY_MAX_DAYS,
  API_KEY_EXPIRY_MIN_DAYS,
  API_KEY_NAME_MAX_LENGTH,
} from '../api-key.constants';
import type { ApiKeyCreateInput } from '../api-key.service';
import { asSent, trimmedAsSent } from './as-sent';
import { RequestedScopeDto } from './requested-scope.dto';

/**
 * More key scopes than any request needs. The permission catalog bounds a
 * real list well below it, and duplicates collapse; the cap only stops a body
 * of thousands from being validated item by item (#1418).
 */
export const API_KEY_SCOPES_MAX = 500;

/** The one preset a create may name: every permission the owner's key may hold, unpinned (#1418). */
export const API_KEY_PRESETS = ['everything'] as const;

/**
 * A new API key (#1418). Each scalar is read as sent, not as the global pipe's
 * implicit conversion leaves it, so `"90"` is not a number of days and
 * `"false"` does not confirm a Critical permission. An optional field
 * validates under `ValidateIf(value !== undefined)` rather than `IsOptional`,
 * which would let `null` through unvalidated.
 *
 * The expiry's range, the key scopes against the owner, and naming both
 * `scopes` and `preset` are the service's checks, each a coded 422.
 */
export class CreateApiKeyDto implements ApiKeyCreateInput {
  @ApiProperty({
    description: `A name that tells your keys apart, 1 to ${API_KEY_NAME_MAX_LENGTH} characters once spaces at either end are trimmed.`,
    minLength: 1,
    maxLength: API_KEY_NAME_MAX_LENGTH,
  })
  @trimmedAsSent
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MinLength(1, { message: i18nValidationMessage('validation.minLength') })
  @MaxLength(API_KEY_NAME_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  @NotContains('\u0000', { message: i18nValidationMessage('validation.noNullCharacter') })
  name!: string;

  @ApiPropertyOptional({
    type: [RequestedScopeDto],
    maxItems: API_KEY_SCOPES_MAX,
    description:
      'What the key may do: each a permission you hold, optionally pinned to one record. A key does no more than ' +
      'you can, whatever it holds. The same key scope named twice is kept once. Left out, with no preset, the key ' +
      'holds no key scope and is refused everywhere. Not beside preset.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayMaxSize(API_KEY_SCOPES_MAX, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => RequestedScopeDto)
  scopes?: RequestedScopeDto[];

  @ApiPropertyOptional({
    enum: API_KEY_PRESETS,
    description:
      'everything: every permission you hold that a key may hold, each unpinned, as the key is created. A ' +
      'permission you gain later is not added. Not beside scopes.',
  })
  @asSent
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(API_KEY_PRESETS, { message: i18nValidationMessage('validation.isIn') })
  preset?: 'everything';

  @ApiPropertyOptional({
    type: 'integer',
    minimum: API_KEY_EXPIRY_MIN_DAYS,
    maximum: API_KEY_EXPIRY_MAX_DAYS,
    default: API_KEY_EXPIRY_DEFAULT_DAYS,
    description:
      `Whole days until the key stops working, ${API_KEY_EXPIRY_MIN_DAYS} to ${API_KEY_EXPIRY_MAX_DAYS}; ` +
      `${API_KEY_EXPIRY_DEFAULT_DAYS} when left out. A key never lasts longer.`,
  })
  @asSent
  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  expiresInDays?: number;

  @ApiPropertyOptional({
    description:
      'true confirms that the key may hold a Critical permission. Required when the key scopes, or the preset, ' +
      'include one; you must also have signed in recently.',
  })
  @asSent
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  confirmCritical?: boolean;
}
