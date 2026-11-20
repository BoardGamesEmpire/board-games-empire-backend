import { ApiProperty } from '@nestjs/swagger';
import { UpstreamPrivacyPolicyDto } from '../../dto/upstream-accounts-response.dto';

/** A Steam sign-in started (#935): where to send the browser, until when, and the policy to show first. */
export class SteamSignInDto {
  @ApiProperty({
    description:
      "Steam's sign-in address. Send the browser there, in the same browser the user is signed in to this " +
      "server in: Steam sends it back to this server, which needs the browser's session to finish the link.",
    example:
      'https://steamcommunity.com/openid/login?openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0&openid.mode=checkid_setup',
  })
  url!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description:
      'When the sign-in stops being usable, in ISO 8601: 30 minutes after it starts. Starting again replaces it.',
    example: '2026-11-19T12:30:00.000Z',
  })
  expiresAt!: string;

  @ApiProperty({
    type: UpstreamPrivacyPolicyDto,
    description: 'The privacy policy to show the user before sending them to Steam.',
  })
  privacyPolicy!: UpstreamPrivacyPolicyDto;
}

/** `POST /api/users/me/upstream-accounts/steam/sign-in`'s answer (#935). */
export class SteamSignInResponseDto {
  @ApiProperty({ type: SteamSignInDto })
  signIn!: SteamSignInDto;
}
