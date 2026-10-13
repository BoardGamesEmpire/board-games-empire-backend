import { SystemRole } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import {
  HOUSEHOLD_INVITE_MAX_MESSAGE_LENGTH,
  HOUSEHOLD_INVITE_MAX_NAME_LENGTH,
} from '../constants/household.constants';
import { ASSIGNABLE_HOUSEHOLD_ROLES, type AssignableHouseholdRole } from './update-member-role.dto';

/**
 * `POST /households/:householdId/invites` (#162).
 *
 * Exactly one of `inviteeId` and `inviteeEmail` names the invitee. That rule
 * spans two fields, so the service enforces it rather than a decorator. There
 * is no `expiresAt`: every invite gets the lib's default window, and the global
 * pipe refuses a field this class does not declare.
 */
export class CreateHouseholdInviteDto {
  @ApiPropertyOptional({ description: 'ID of a registered user to invite. Give this or `inviteeEmail`, not both.' })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  inviteeId?: string;

  @ApiPropertyOptional({
    description:
      'Address to invite. Give this or `inviteeId`, not both. The invite is email-only whether or not an ' +
      'account holds the address, and no answer, a refusal included, says whether one does. A second ' +
      'outstanding invite to the same address is refused with 409.',
  })
  @IsOptional()
  // Trimmed before validation so a padded address is checked, and stored, as
  // the address it is.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsEmail(undefined, { message: i18nValidationMessage('validation.isEmail') })
  inviteeEmail?: string;

  @ApiPropertyOptional({
    description:
      'How the household sees the invitee until they answer. For an invite by id, defaults to the ' +
      "account's display name, or its username.",
    maxLength: HOUSEHOLD_INVITE_MAX_NAME_LENGTH,
  })
  @IsOptional()
  // Trimmed, and refused when nothing is left: a blank name would override the
  // account's and leave the household's list with a row that names nobody.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(HOUSEHOLD_INVITE_MAX_NAME_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  inviteeName?: string;

  @ApiPropertyOptional({
    enum: ASSIGNABLE_HOUSEHOLD_ROLES,
    default: SystemRole.HouseholdMember,
    description: 'The role the invitee joins with. Ownership is transferred, never offered.',
  })
  @IsOptional()
  @IsIn(ASSIGNABLE_HOUSEHOLD_ROLES, { message: i18nValidationMessage('validation.isIn') })
  role?: AssignableHouseholdRole;

  @ApiPropertyOptional({
    description: 'A note to the invitee. Only the inviter and the invitee see it.',
    maxLength: HOUSEHOLD_INVITE_MAX_MESSAGE_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(HOUSEHOLD_INVITE_MAX_MESSAGE_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  message?: string;
}
