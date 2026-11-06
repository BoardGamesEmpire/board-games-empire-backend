import { ApiProperty } from '@nestjs/swagger';
import { AuthStrategyType } from '../constants';

export class EmailAndPasswordStrategyDto {
  @ApiProperty({ enum: [AuthStrategyType.EmailAndPassword], example: AuthStrategyType.EmailAndPassword })
  readonly type = AuthStrategyType.EmailAndPassword as const;

  @ApiProperty({
    description:
      "Whether new account registration via email/password is disabled. Follows the server settings' registration switch.",
  })
  signUpDisabled!: boolean;

  @ApiProperty({
    description: 'Relative endpoint for email/password sign-in. POST with { email, password }.',
    example: '/api/auth/sign-in/email',
  })
  signInEndpoint!: string;

  @ApiProperty({
    description: 'Relative endpoint for email/password registration. Absent when signUpDisabled is true.',
    example: '/api/auth/sign-up/email',
    required: false,
  })
  signUpEndpoint?: string;

  @ApiProperty({
    description:
      'Whether a password reset can be requested: the server settings allow resets and outgoing mail is set up.',
  })
  passwordResetAvailable!: boolean;

  @ApiProperty({
    description:
      'Relative endpoint to request a password reset email. POST with { email, redirectTo }. Absent when passwordResetAvailable is false.',
    example: '/api/auth/request-password-reset',
    required: false,
  })
  requestPasswordResetEndpoint?: string;

  @ApiProperty({
    description:
      'Relative endpoint to set a new password with the token from the reset email. POST with { newPassword, token }. Listed whenever the server settings allow resets, even with outgoing mail not set up, because a link mailed earlier still works. Absent when resets are off.',
    example: '/api/auth/reset-password',
    required: false,
  })
  resetPasswordEndpoint?: string;
}
