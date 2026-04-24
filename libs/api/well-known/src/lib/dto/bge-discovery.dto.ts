import { ApiProperty } from '@nestjs/swagger';
import { EmailAndPasswordStrategyDto } from './email-and-password-strategy.dto';
import { OidcStrategyDto } from './oidc-strategy.dto';

export type AuthStrategyDto = EmailAndPasswordStrategyDto | OidcStrategyDto;

/**
 * BGE server identity and authentication discovery document.
 *
 * Modeled after RFC 8414 (OAuth Authorization Server Metadata) and
 * OpenID Connect Discovery conventions. Fields follow those specs where
 * they directly apply; BGE-specific extensions are prefixed with `bge`.
 *
 * Served at `/.well-known/bge-identity` with snake_case keys via
 * SnakeCaseInterceptor. All endpoints are absolute URLs.
 */
export class BgeDiscoveryDto {
  /**
   * The server's canonical base URL. Equivalent to the `issuer` in RFC 8414.
   * Clients can use this to confirm they are talking to the expected server.
   */
  @ApiProperty({ description: 'Canonical base URL of this BGE server', example: 'https://api.example.com' })
  issuer!: string;

  /**
   * Device authorization endpoint per RFC 8628
   */
  @ApiProperty({
    description: 'Device authorization endpoint (RFC 8628). Always available.',
    example: 'https://api.example.com/api/auth/device',
  })
  deviceAuthorizationEndpoint!: string;

  /**
   * The BetterAuth base URL. Useful for SDK integration and constructing
   * any auth endpoint not listed explicitly in this document.
   */
  @ApiProperty({
    description: 'BetterAuth base URL (bge_ extension)',
    example: 'https://api.example.com/api/auth',
  })
  bgeAuthBaseUrl!: string;

  /**
   * Endpoint to retrieve the current user session.
   * GET — returns session data if authenticated, 401 if not.
   */
  @ApiProperty({
    description: 'Session retrieval endpoint (bge_ extension)',
    example: 'https://api.example.com/api/auth/get-session',
  })
  bgeSessionEndpoint!: string;

  /**
   * Endpoint to terminate the current session.
   * POST — invalidates the session cookie / bearer token.
   */
  @ApiProperty({
    description: 'Sign-out endpoint (bge_ extension)',
    example: 'https://api.example.com/api/auth/sign-out',
  })
  bgeSignOutEndpoint!: string;

  /**
   * Passkey (WebAuthn) authentication is always available.
   * Clients should offer passkey registration/sign-in flows.
   */
  @ApiProperty({ description: 'Whether passkey (WebAuthn) authentication is supported', example: true })
  bgePasskeySupported!: boolean;

  /**
   * Two-factor authentication is always available.
   * After a successful primary sign-in, clients may be required to complete a 2FA step.
   */
  @ApiProperty({ description: 'Whether two-factor authentication is supported', example: true })
  bgeTwoFactorSupported!: boolean;

  /**
   * Anonymous authentication is always available.
   * Clients may create anonymous sessions that can later be linked to a real account.
   */
  @ApiProperty({ description: 'Whether anonymous authentication is supported', example: true })
  bgeAnonymousAuthSupported!: boolean;

  /**
   * The set of authentication strategies enabled on this server.
   * Each entry includes the endpoints clients need to initiate that strategy.
   * An empty array means no interactive authentication is available
   * (device flow or passkey only).
   */
  @ApiProperty({
    description: 'Enabled authentication strategies with their endpoints',
    type: 'array',
    items: {
      oneOf: [
        { $ref: '#/components/schemas/EmailAndPasswordStrategyDto' },
        { $ref: '#/components/schemas/OidcStrategyDto' },
      ],
    },
  })
  strategies!: AuthStrategyDto[];
}
