import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { PRIVACY_POLICY_MAX_LENGTH } from '../privacy-policy.constants';

/** `PUT /api/privacy-policy/:languageTag` (#934): the operator's privacy policy in one language. */
export class PutPrivacyPolicyDto {
  @ApiProperty({
    description:
      `The privacy policy in Markdown, at most ${PRIVACY_POLICY_MAX_LENGTH} characters, counted as UTF-16 code ` +
      'units: a character outside the Basic Multilingual Plane, such as most emoji, counts as two. It is ' +
      'sanitized as every Markdown the server stores is: raw HTML is removed, and a link that is not http, ' +
      'https or mailto is reduced to its text. Its headings and lists are kept, so a screen reader can move ' +
      'through it. Markdown with nothing left once sanitized is refused. Sending the text already saved ' +
      'changes nothing.',
    maxLength: PRIVACY_POLICY_MAX_LENGTH,
    example: '# Privacy policy\n\nThis server keeps your account details so that you can sign in.\n',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(PRIVACY_POLICY_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  markdown!: string;
}
