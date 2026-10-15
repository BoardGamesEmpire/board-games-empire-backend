import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Generous next to the 43 characters a minted token has, and short enough
 * that no request makes the lookup compare an arbitrary payload.
 */
const INVITE_TOKEN_MAX_LENGTH = 256;

/**
 * `POST /invites/accept` (#163).
 *
 * The token is the invite's accept credential (#161), so it travels in the
 * body and never in the path: a path reaches proxy access logs, browser
 * history and `Referer` headers.
 */
export class AcceptInviteByTokenDto {
  @ApiProperty({ description: 'The token from the invite link.', maxLength: INVITE_TOKEN_MAX_LENGTH })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(INVITE_TOKEN_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  token!: string;
}
