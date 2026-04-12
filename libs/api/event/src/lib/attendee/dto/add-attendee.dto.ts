import { EventParticipationStatus, SystemRole } from '@bge/database';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, ValidateIf } from 'class-validator';

export class AddAttendeeDto {
  @ApiPropertyOptional({ description: 'ID of a registered user. Omit for guest attendees.' })
  @IsString()
  @IsOptional()
  userId?: string;

  @ApiPropertyOptional({
    description: 'Name of the guest. Intended for non-registered users. Required when userId is not provided',
  })
  @IsString()
  @ValidateIf((o: AddAttendeeDto) => !o.userId)
  guestName?: string;

  @ApiPropertyOptional({
    description: 'Email of the guest. Intended for non-registered users. Required when userId is not provided',
  })
  @IsEmail()
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
  @IsEnum(SystemRole)
  @IsOptional()
  role?: SystemRole;

  @ApiPropertyOptional({ enum: EventParticipationStatus, default: EventParticipationStatus.Invited })
  @IsEnum(EventParticipationStatus)
  @IsOptional()
  status?: EventParticipationStatus;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;
}
