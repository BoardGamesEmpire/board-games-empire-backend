import { EventSchedulingMode, EventType, Visibility } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsEnum, IsOptional, IsString, IsUrl, ValidateNested } from 'class-validator';
import { CreateEventOccurrenceDto } from '../occurrence/dto/create-event-occurrence.dto';
import { CreateEventPolicyDto } from './create-event-policy.dto';

export class CreateEventDto {
  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  title!: string;

  @ApiPropertyOptional({ description: 'Optional household this event is associated with' })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  householdId?: string;

  @ApiPropertyOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  description?: string;

  @ApiPropertyOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  image?: string;

  @ApiPropertyOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsOptional()
  location?: string;

  @ApiPropertyOptional()
  @IsUrl(undefined, { message: i18nValidationMessage('validation.isUrl') })
  @IsOptional()
  url?: string;

  @ApiPropertyOptional({ enum: EventType, default: EventType.CasualGathering })
  @IsEnum(EventType, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  type?: EventType;

  @ApiPropertyOptional({ enum: Visibility, default: Visibility.Friends })
  @IsEnum(Visibility, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  visibility?: Visibility;

  @ApiPropertyOptional({ enum: EventSchedulingMode, default: EventSchedulingMode.Fixed })
  @IsEnum(EventSchedulingMode, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  schedulingMode?: EventSchedulingMode;

  @ApiPropertyOptional({
    type: [String],
    description:
      'User IDs to invite to the event at creation time. ' +
      'Each user is added as an EventParticipant with Invited status.',
  })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.isString') })
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
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
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
