import { EventSchedulingMode, EventType, Reach } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ReachProperty } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  ValidateNested,
} from 'class-validator';
import { CreateEventOccurrenceDto } from '../occurrence/dto/create-event-occurrence.dto';
import { CreateEventPolicyDto } from './create-event-policy.dto';

/**
 * How many users one create may invite (#546). Each is checked in the create's
 * transaction before anything is written, so the list was a request-sized
 * amount of work with no bound.
 */
export const MAX_INVITE_USER_IDS = 50;

const EVENT_REACHES = [Reach.Private, Reach.Friends] as const;
export type EventReach = (typeof EVENT_REACHES)[number];

/**
 * An event's reach: Private or Friends only, the rungs an event read rule
 * serves. `Public` arrives with its rule (#809), and `FriendsOfFriends` with
 * #496, which defines friends of friends. Shared with `UpdateEventDto`, which
 * names no default.
 */
export function EventReachProperty(defaultReach?: EventReach): PropertyDecorator {
  return ReachProperty({
    reaches: EVENT_REACHES,
    default: defaultReach,
    description:
      "Who may read the event besides its attendees and its household's members. `Friends`: also its " +
      "creator's friends. `Private`: no one else.",
  });
}

export class CreateEventDto {
  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  title!: string;

  @ApiPropertyOptional({
    description:
      'Optional household this event is associated with. Requires a role in that household that may create ' +
      'its events (owner, admin or member); 403 otherwise. Set at creation only: an update cannot change it. ' +
      'Omit it or send null for an event outside any household; an empty string is rejected.',
    nullable: true,
  })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @IsOptional()
  householdId?: string | null;

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

  @EventReachProperty(Reach.Friends)
  reach?: EventReach;

  @ApiPropertyOptional({ enum: EventSchedulingMode, default: EventSchedulingMode.Fixed })
  @IsEnum(EventSchedulingMode, { message: i18nValidationMessage('validation.isEnum') })
  @IsOptional()
  schedulingMode?: EventSchedulingMode;

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_INVITE_USER_IDS,
    description:
      'User IDs to invite to the event at creation time. ' +
      'Each user is added as an EventParticipant with Invited status. ' +
      "An id that names no person answers 404, and one the server's or the user's invite settings refuse answers 403; either way nothing is written.",
  })
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  @ArrayMaxSize(MAX_INVITE_USER_IDS, { message: i18nValidationMessage('validation.arrayMaxSize') })
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
