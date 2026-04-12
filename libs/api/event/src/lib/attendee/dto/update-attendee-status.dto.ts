import { EventParticipationStatus } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';

export class UpdateAttendeeStatusDto {
  @ApiProperty({ enum: EventParticipationStatus })
  @IsEnum(EventParticipationStatus)
  status!: EventParticipationStatus;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  notes?: string;
}
