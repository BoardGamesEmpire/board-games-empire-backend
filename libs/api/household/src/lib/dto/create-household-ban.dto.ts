import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { HOUSEHOLD_BAN_MAX_REASON_LENGTH } from '../constants/household.constants';

/** `POST /households/:householdId/bans` (#782). */
export class CreateHouseholdBanDto {
  @ApiProperty({ description: 'ID of the user to ban. A member is removed from the household.' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  userId!: string;

  @ApiPropertyOptional({
    description: "Why they are banned. Only the household's owners and admins see it.",
    maxLength: HOUSEHOLD_BAN_MAX_REASON_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(HOUSEHOLD_BAN_MAX_REASON_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  reason?: string;
}
