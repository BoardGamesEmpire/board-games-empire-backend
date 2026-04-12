import { EventSchedulingMode, EventType, Visibility } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsOptional, IsString, IsUrl, ValidateNested } from 'class-validator';
import { CreateEventOccurrenceDto } from '../occurrence/dto/create-event-occurrence.dto';
import { CreateEventPolicyDto } from './create-event-policy.dto';

export class CreateEventDto {
  @ApiProperty()
  @IsString()
  title!: string;

  @ApiPropertyOptional({ description: 'Optional household this event is associated with' })
  @IsString()
  @IsOptional()
  householdId?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  image?: string;

  @ApiPropertyOptional()
  @IsString()
  @IsOptional()
  location?: string;

  @ApiPropertyOptional()
  @IsUrl()
  @IsOptional()
  url?: string;

  @ApiPropertyOptional({ enum: EventType, default: EventType.CasualGathering })
  @IsEnum(EventType)
  @IsOptional()
  type?: EventType;

  @ApiPropertyOptional({ enum: Visibility, default: Visibility.Friends })
  @IsEnum(Visibility)
  @IsOptional()
  visibility?: Visibility;

  @ApiPropertyOptional({ enum: EventSchedulingMode, default: EventSchedulingMode.Fixed })
  @IsEnum(EventSchedulingMode)
  @IsOptional()
  schedulingMode?: EventSchedulingMode;

  @ApiPropertyOptional({
    type: [String],
    description:
      'User IDs to invite to the event at creation time. ' +
      'Each user is added as an EventParticipant with Invited status.',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  inviteUserIds?: string[];

  // Fixed mode — single occurrence with an optional start date.
  // Modelled as an array of one for API consistency with Poll/MultiDay;
  // service layer enforces the single-occurrence constraint.
  @ApiPropertyOptional({
    type: [CreateEventOccurrenceDto],
    description:
      'Fixed: provide one occurrence. Poll: provide multiple proposed dates. MultiDay: provide multiple confirmed dates.',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateEventOccurrenceDto)
  @IsOptional()
  occurrences?: CreateEventOccurrenceDto[];

  @ApiPropertyOptional({ type: CreateEventPolicyDto })
  @ValidateNested()
  @Type(() => CreateEventPolicyDto)
  @IsOptional()
  policy?: CreateEventPolicyDto;
}
