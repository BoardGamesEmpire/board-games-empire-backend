import { EventParticipationStatus, SystemRole } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator';

/**
 * The roles an attendee can be added with: the event roles, less `EventHost`,
 * which belongs to whoever created the event.
 *
 * This list is the only check on which role a row may name. The ability
 * factory applies whatever role an attendee row names, and applies an
 * unconditioned grant everywhere, so a global role accepted here would reach
 * far past the event: `Owner` is `manage:all` (#429). Who may give out each
 * role is the catalog's: an organizer's or moderator's attendee grants name
 * the roles they may give out (#539).
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

/**
 * Whether the body names a user. One that does is refused by the service with
 * its own code, ATTENDEE_ACCOUNT_NEEDS_INVITE (#742), so the name and email
 * checks stand aside for it rather than answer with a missing name.
 */
const namesNoUser = (o: AddAttendeeDto) => o.userId === undefined;

/**
 * A person added to the event directly, by name: someone without an account
 * (#742). Everyone with an account is invited instead
 * (`POST /events/:eventId/invites`) and becomes an attendee by accepting.
 */
export class AddAttendeeDto {
  @ApiPropertyOptional({
    description:
      'Refused with 400, code `ATTENDEE_ACCOUNT_NEEDS_INVITE`: someone with an account is invited instead, ' +
      'with `POST /events/:eventId/invites`, and becomes an attendee by accepting.',
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  userId?: string;

  @ApiProperty({ description: 'Name of the person, who has no account' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @ValidateIf(namesNoUser)
  guestName?: string;

  @ApiProperty({ description: 'Email address of the person, who has no account' })
  @IsEmail(undefined, { message: i18nValidationMessage('validation.isEmail') })
  @ValidateIf(namesNoUser)
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
