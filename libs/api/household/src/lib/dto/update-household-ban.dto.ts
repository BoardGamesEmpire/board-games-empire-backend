import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';
import { HOUSEHOLD_BAN_MAX_REASON_LENGTH } from '../constants/household.constants';

/**
 * `PATCH /households/:householdId/bans/:userId` (#782): sets, replaces or
 * clears a ban's reason. The field is required, so clearing it is said with
 * `null` rather than by leaving it out.
 */
export class UpdateHouseholdBanDto {
  @ApiProperty({
    description: "The ban's new reason, or `null` to clear it. Only the household's owners and admins see it.",
    type: String,
    nullable: true,
    maxLength: HOUSEHOLD_BAN_MAX_REASON_LENGTH,
  })
  @ValidateIf((dto: UpdateHouseholdBanDto) => dto.reason !== null)
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(HOUSEHOLD_BAN_MAX_REASON_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  reason!: string | null;
}
