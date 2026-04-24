import { ApiProperty } from '@nestjs/swagger';
import { AuthStrategyType } from '../constants';

export class EmailAndPasswordStrategyDto {
  @ApiProperty({ enum: [AuthStrategyType.EmailAndPassword], example: AuthStrategyType.EmailAndPassword })
  readonly type = AuthStrategyType.EmailAndPassword as const;

  @ApiProperty({ description: 'Whether new account registration via email/password is disabled' })
  signUpDisabled!: boolean;

  @ApiProperty({
    description: 'Absolute endpoint for email/password sign-in. POST with { email, password }.',
    example: 'https://api.example.com/api/auth/sign-in/email',
  })
  signInEndpoint!: string;

  @ApiProperty({
    description: 'Absolute endpoint for email/password registration. Absent when signUpDisabled is true.',
    example: 'https://api.example.com/api/auth/sign-up/email',
    required: false,
  })
  signUpEndpoint?: string;
}
