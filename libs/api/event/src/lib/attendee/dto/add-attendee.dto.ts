import { EventParticipationStatus, SystemRole } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsIn, IsOptional, IsString, ValidateIf } from 'class-validator';

/**
 * The roles an attendee can be added with: the event roles, less `EventHost`,
 * which belongs to whoever created the event.
 *
 * This list is the only check on the role. The ability factory applies
 * whatever role an attendee row names, and applies an unconditioned grant
 * everywhere, so a global role accepted here would reach far past the event:
 * `Owner` is `manage:all` (#429).
 */
export const ASSIGNABLE_ATTENDEE_ROLES = [
  SystemRole.EventParticipant,
  SystemRole.EventGuest,
  SystemRole.EventSpectator,
  SystemRole.EventCoHost,
  SystemRole.EventOrganizer,
  SystemRole.EventModerator,
] as const;

export type AssignableAttendeeRole = (typeof ASSIGNABLE_ATTENDEE_ROLES)[number];

export class AddAttendeeDto {
  @ApiPropertyOptional({ description: 'ID of a registered user. Omit for guest attendees.' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  userId?: string;

  @ApiPropertyOptional({
    description: 'Name of the guest. Intended for non-registered users. Required when userId is not provided',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @ValidateIf((o: AddAttendeeDto) => !o.userId)
  guestName?: string;

  @ApiPropertyOptional({
    description: 'Email of the guest. Intended for non-registered users. Required when userId is not provided',
  })
  @IsEmail(undefined, { message: i18nValidationMessage('validation.isEmail') })
  @ValidateIf((o: AddAttendeeDto) => !o.userId)
  guestEmail?: string;

  @ApiPropertyOptional({ enum: ASSIGNABLE_ATTENDEE_ROLES, default: SystemRole.EventParticipant })
  @IsIn(ASSIGNABLE_ATTENDEE_ROLES, { message: i18nValidationMessage('validation.isIn') })
  @IsOptional()
  role?: AssignableAttendeeRole;

  @ApiPropertyOptional({ enum: EventParticipationStatus, default: EventParticipationStatus.Invited })
  @IsEnum(EventParticipationStatus, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  status?: EventParticipationStatus;

  @ApiPropertyOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  notes?: string;
}
