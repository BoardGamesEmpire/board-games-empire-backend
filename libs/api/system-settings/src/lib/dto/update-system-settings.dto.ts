import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNumber, IsOptional } from 'class-validator';

export class UpdateSystemSettingsDto {
  @ApiProperty({
    description: 'Whether to allow users to reset their passwords',
  })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  allowPasswordResets?: boolean;

  @ApiProperty({
    description: 'Whether to allow new user registrations',
  })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  allowUserRegistration?: boolean;

  @ApiProperty({
    description: 'Whether to allow users to change their usernames',
  })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  allowUsernameChange?: boolean;

  @ApiProperty({
    description:
      'How long to keep feedback reports, in days. Feedback reports older than this will be automatically deleted.',
  })
  @IsNumber(undefined, { message: i18nValidationMessage('validation.isNumber') })
  @IsOptional()
  feedbackRetentionDays?: number;

  @ApiProperty({
    description:
      'Whether the server should apply redaction to feedback reports before storing them. If false, the server will store feedback reports as-is and rely on clients to apply redaction.',
  })
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  @IsOptional()
  feedbackReportServerRedactionEnabled?: boolean;
}
