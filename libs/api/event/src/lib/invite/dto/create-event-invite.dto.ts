import { SystemRole } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import type { AssignableAttendeeRole } from '../../attendee/dto/add-attendee.dto';
import { ASSIGNABLE_ATTENDEE_ROLES } from '../../attendee/dto/add-attendee.dto';

/** The longest note an inviter may write to the invitee, as a household invite allows (#742). */
export const EVENT_INVITE_MAX_MESSAGE_LENGTH = 1_000;

/**
 * `POST /events/:eventId/invites` (#742): invite a registered user to
 * the event, by user id, offering an event role. Inviting someone without an
 * account, by address, is #488's. There is no `expiresAt`: every invite gets
 * the invites lib's default window, and the global pipe refuses a field this
 * class does not declare.
 */
export class CreateEventInviteDto {
  @ApiProperty({ description: 'ID of the user to invite.' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  userId!: string;

  @ApiPropertyOptional({
    enum: ASSIGNABLE_ATTENDEE_ROLES,
    default: SystemRole.EventParticipant,
    description:
      'The event role the invitee attends with once they accept. Host is never offered. Any role but ' +
      "participant needs the grant that gives that role out directly: the event's host or co-host, or an " +
      'owner or admin of its household.',
  })
  @IsOptional()
  @IsIn(ASSIGNABLE_ATTENDEE_ROLES, { message: i18nValidationMessage('validation.isIn') })
  role?: AssignableAttendeeRole;

  @ApiPropertyOptional({
    description: 'A note to the invitee. Only the inviter and the invitee see it.',
    maxLength: EVENT_INVITE_MAX_MESSAGE_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(EVENT_INVITE_MAX_MESSAGE_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  message?: string;
}
