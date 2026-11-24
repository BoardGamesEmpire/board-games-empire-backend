import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsString,
  MaxLength,
  MinLength,
  NotContains,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { API_KEY_EXPIRY_MAX_DAYS, API_KEY_EXPIRY_MIN_DAYS, API_KEY_NAME_MAX_LENGTH } from '../api-key.constants';
import type { ApiKeyUpdateInput } from '../api-key.service';
import { asSent, trimmedAsSent } from './as-sent';
import { API_KEY_SCOPES_MAX } from './create-api-key.dto';
import { RequestedScopeDto } from './requested-scope.dto';

/**
 * An edit to one of your API keys (#1418). A field left out stays as it is;
 * `null` is refused for every field. Each scalar is read as sent, as
 * {@link CreateApiKeyDto}'s are, so `"false"` neither enables a key nor
 * confirms a Critical permission. There is no preset: an edit names its key
 * scopes.
 */
export class UpdateApiKeyDto implements ApiKeyUpdateInput {
  @ApiPropertyOptional({
    description: `A new name, 1 to ${API_KEY_NAME_MAX_LENGTH} characters once spaces at either end are trimmed.`,
    minLength: 1,
    maxLength: API_KEY_NAME_MAX_LENGTH,
  })
  @trimmedAsSent
  @ValidateIf((_, value) => value !== undefined)
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MinLength(1, { message: i18nValidationMessage('validation.minLength') })
  @MaxLength(API_KEY_NAME_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  @NotContains('\u0000', { message: i18nValidationMessage('validation.noNullCharacter') })
  name?: string;

  @ApiPropertyOptional({
    type: [RequestedScopeDto],
    maxItems: API_KEY_SCOPES_MAX,
    description:
      'Replaces every key scope the key holds; an empty list leaves it none. Adding a Critical permission the key ' +
      'does not already hold needs confirmCritical and a recent sign-in.',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @ArrayMaxSize(API_KEY_SCOPES_MAX, { message: i18nValidationMessage('validation.arrayMaxSize') })
  @ValidateNested({ each: true })
  @Type(() => RequestedScopeDto)
  scopes?: RequestedScopeDto[];

  @ApiPropertyOptional({
    type: 'integer',
    minimum: API_KEY_EXPIRY_MIN_DAYS,
    maximum: API_KEY_EXPIRY_MAX_DAYS,
    description:
      `Sets the expiry this many whole days from now, ${API_KEY_EXPIRY_MIN_DAYS} to ${API_KEY_EXPIRY_MAX_DAYS}, ` +
      'earlier or later than the one the key has.',
  })
  @asSent
  @ValidateIf((_, value) => value !== undefined)
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  expiresInDays?: number;

  @ApiPropertyOptional({
    description: 'false disables the key, which is refused from its next request; true enables it again.',
  })
  @asSent
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'true confirms a Critical permission the new key scopes add. A Critical permission the key already holds ' +
      'needs no confirmation.',
  })
  @asSent
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  confirmCritical?: boolean;
}
