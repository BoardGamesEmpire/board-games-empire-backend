import { EventParticipationStatus } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdateAttendeeStatusDto {
  @ApiProperty({ enum: EventParticipationStatus })
  @IsEnum(EventParticipationStatus, { message: i18nValidationMessage('validation.isEnum') })
  status!: EventParticipationStatus;

  @ApiPropertyOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  notes?: string;
}
