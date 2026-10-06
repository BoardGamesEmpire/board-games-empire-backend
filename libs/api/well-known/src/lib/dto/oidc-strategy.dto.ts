import { ApiProperty } from '@nestjs/swagger';
import { AuthStrategyType } from '../constants';

export class OidcStrategyDto {
  @ApiProperty({ enum: [AuthStrategyType.Oidc], example: AuthStrategyType.Oidc })
  readonly type = AuthStrategyType.Oidc as const;

  /**
   * A first sign-in creates the account, so it is refused while registration
   * is closed. The strategy stays listed regardless: existing accounts still
   * sign in through it.
   */
  @ApiProperty({
    description:
      "Whether a first sign-in, which would create the account, is refused. Follows the server settings' registration switch; existing accounts still sign in.",
  })
  signUpDisabled!: boolean;

  /**
   * The provider identifier passed to BetterAuth's oauth2 sign-in endpoint.
   * Clients construct: GET <authorizationEndpoint>?callbackURL=<yourCallback>
   */
  @ApiProperty({ description: 'Provider ID used to identify this OIDC provider', example: 'my-company-sso' })
  providerId!: string;

  /**
   * The OIDC well-known discovery URL. Public endpoint — safe to expose.
   * Advanced clients may use this to inspect scopes, PKCE requirements, etc.
   */
  @ApiProperty({
    description: 'The OIDC well-known discovery URL (public endpoint)',
    example: 'https://auth.example.com/.well-known/openid-configuration',
  })
  discoveryUrl!: string;

  /**
   * The BetterAuth endpoint to initiate the OAuth2/OIDC redirect for this provider.
   * Clients POST here (with { providerId, callbackURL }); BetterAuth handles the
   * redirect and code exchange via the genericOAuth plugin.
   */
  @ApiProperty({
    description: 'Relative endpoint to initiate the OAuth2 sign-in flow for this provider (POST)',
    example: '/api/auth/sign-in/oauth2',
  })
  authorizationEndpoint!: string;
}
