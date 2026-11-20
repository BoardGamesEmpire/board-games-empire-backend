import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { UpstreamAccountDto } from '../../dto/upstream-account.dto';

/** The longest username a link by username takes (#1226). */
export const LINK_USERNAME_MAX_LENGTH = 64;

/** Trimmed, so a username of only spaces is refused as empty rather than looked up. */
const trimmed = Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** `POST /api/users/me/upstream-accounts/boardgamegeek` (#1226). */
export class LinkByUsernameDto {
  @ApiProperty({
    description:
      'Your username at BoardGameGeek, as you sign in there. Trimmed. Never send your BoardGameGeek password: ' +
      'this server never asks for it.',
    minLength: 1,
    maxLength: LINK_USERNAME_MAX_LENGTH,
    example: 'BGFan',
  })
  @trimmed
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MinLength(1, { message: i18nValidationMessage('validation.minLength') })
  @MaxLength(LINK_USERNAME_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  username!: string;
}

/** A link by username's answer (#1226). */
export class UpstreamAccountLinkedResponseDto {
  @ApiProperty({
    example:
      'Your BoardGameGeek account is linked. It is marked unverified, because BoardGameGeek has no way to confirm ' +
      'an account is yours.',
  })
  message!: string;

  @ApiProperty({
    type: UpstreamAccountDto,
    description:
      'The account linked, with `verified: false` and the username as BoardGameGeek writes it, which may differ ' +
      'in capitals from what you sent.',
  })
  upstreamAccount!: UpstreamAccountDto;
}
