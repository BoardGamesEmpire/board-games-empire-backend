import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class UpdateSystemSettingsDto {
  @ApiProperty({
    description: 'Whether to allow users to reset their passwords',
  })
  @IsBoolean()
  @IsOptional()
  allowPasswordResets?: boolean;

  @ApiProperty({
    description: 'Whether to allow new user registrations',
  })
  @IsBoolean()
  @IsOptional()
  allowUserRegistration?: boolean;

  @ApiProperty({
    description: 'Whether to allow users to change their usernames',
  })
  @IsBoolean()
  @IsOptional()
  allowUsernameChange?: boolean;
}
