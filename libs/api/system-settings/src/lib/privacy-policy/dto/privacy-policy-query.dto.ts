import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * The longest `lang` the route accepts (#934): 35 characters, the length
 * RFC 5646 (section 4.4.1) asks every language tag reader to support.
 */
export const PRIVACY_POLICY_LANG_MAX_LENGTH = 35;

/** `GET /api/privacy-policy` (#934). */
export class PrivacyPolicyQueryDto {
  @ApiPropertyOptional({
    description:
      "The language tag to read the policy in, such as `de` or `pt-BR`. It is tried before a signed-in reader's stored language and `Accept-Language`, " +
      'and a regional tag matches its base language. A language the policy is not available in, or a value ' +
      'that is not a language tag, falls back to the stored language, then `Accept-Language`, then English, instead of failing.',
    maxLength: PRIVACY_POLICY_LANG_MAX_LENGTH,
    example: 'de',
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(PRIVACY_POLICY_LANG_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  lang?: string;
}
