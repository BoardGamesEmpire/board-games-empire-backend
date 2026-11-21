import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';

/** The longest return address a Steam sign-in accepts (#935). */
export const STEAM_SIGN_IN_RETURN_TO_MAX_LENGTH = 2048;

/** `POST /api/users/me/upstream-accounts/steam/sign-in` (#935). */
export class StartSteamSignInDto {
  @ApiProperty({
    description:
      "Where to send the browser once Steam's answer is settled: an absolute http or https address at one of " +
      "this server's trusted origins (`TRUSTED_ORIGINS`). It comes back with `upstreamAccount=steam` and either " +
      '`result=linked` or `error=<code>` added to its query.',
    maxLength: STEAM_SIGN_IN_RETURN_TO_MAX_LENGTH,
    example: 'https://app.example/settings/upstream-accounts',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(STEAM_SIGN_IN_RETURN_TO_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  returnTo!: string;
}
