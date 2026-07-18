import { EventParticipationStatus, SystemRole } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, ValidateIf } from 'class-validator';

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

  @ApiPropertyOptional({
    enum: [
      SystemRole.EventParticipant,
      SystemRole.EventGuest,
      SystemRole.EventSpectator,
      SystemRole.EventCoHost,
      SystemRole.EventOrganizer,
      SystemRole.EventModerator,
    ],
    default: SystemRole.EventParticipant,
  })
  @IsEnum(SystemRole, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  role?: SystemRole;

  @ApiPropertyOptional({ enum: EventParticipationStatus, default: EventParticipationStatus.Invited })
  @IsEnum(EventParticipationStatus, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  status?: EventParticipationStatus;

  @ApiPropertyOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  notes?: string;
}
