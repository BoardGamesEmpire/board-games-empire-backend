import { Visibility } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { HOUSEHOLD_MAX_CLIENT_REQUEST_ID_LENGTH } from '../constants/household.constants';

export class CreateHouseholdDto {
  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  name!: string;

  @ApiPropertyOptional({
    enum: Visibility,
    description: "Set to 'Friends' to let members' friends view this household",
  })
  @IsOptional()
  @IsEnum(Visibility, { message: i18nValidationMessage('validation.isEnum') })
  visibility?: Visibility;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  image?: string;

  @ApiPropertyOptional({ description: "IETF BCP 47 language tag, e.g. 'en', 'pt-BR', 'zh-Hant'" })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  language?: string;

  @ApiPropertyOptional({
    description:
      'Client-supplied idempotency key, scoped per user. A repeat POST with the same key returns the ' +
      'ORIGINAL household (same id, same 201 envelope) instead of creating a duplicate — the payload of ' +
      'the repeat is ignored (first writer wins). Keys are retained indefinitely. The Flutter client ' +
      'sends its queued operation `localId` (a cuid2), but any stable opaque string is accepted. ' +
      'Surrounding whitespace is trimmed; a blank key is rejected rather than silently ignored.',
    minLength: 1,
    maxLength: HOUSEHOLD_MAX_CLIENT_REQUEST_ID_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MinLength(1, { message: i18nValidationMessage('validation.minLength') })
  @MaxLength(HOUSEHOLD_MAX_CLIENT_REQUEST_ID_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  // Trim before length validation so a whitespace-only key collapses to '' and
  // fails MinLength (a 400) rather than reaching the service, where it would be
  // normalized away and silently cost the caller its idempotency guarantee.
  // Trimming also makes retries that differ only in padding hash to one key.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  clientRequestId?: string;
}
