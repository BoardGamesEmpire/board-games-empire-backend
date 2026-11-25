import { EventSchedulingMode, EventType, Reach } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ClientRequestIdProperty, ReachProperty } from '@bge/shared';
import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { CreateEventOccurrenceDto } from '../occurrence/dto/create-event-occurrence.dto';
import { CreateEventPolicyDto } from './create-event-policy.dto';

/**
 * How many users one create may invite (#546). Each is checked, and sent an
 * invite, in the create's transaction (#742), so the list was a request-sized
 * amount of work with no bound.
 */
export const MAX_INVITE_USER_IDS = 50;

const EVENT_REACHES = [
  Reach.Private,
  Reach.Friends,
  Reach.FriendsOfFriends,
  Reach.ExtendedNetwork,
  Reach.Public,
] as const;
export type EventReach = (typeof EVENT_REACHES)[number];

/**
 * An event's reach: every rung an event read rule serves, friends of friends
 * (#496) and the extended network (#497) included. Shared with
 * `UpdateEventDto`, which names no default.
 */
export function EventReachProperty(defaultReach?: EventReach): PropertyDecorator {
  return ReachProperty({
    reaches: EVENT_REACHES,
    default: defaultReach,
    description:
      "Who may read the event besides its attendees and its household's members. `Friends`: also its " +
      "creator's friends. `FriendsOfFriends`: also its creator's friends and friends of friends, unless " +
      'a block stands between the creator and the reader. `ExtendedNetwork`: also everyone up to three ' +
      'friendship steps from its creator, unless a block stands between the creator and the reader. A reader ' +
      'who is no longer within three steps may keep access for a short while: usually seconds after an ' +
      'unfriend, up to a day after a user who linked them is deleted. `Public`: every signed-in user. ' +
      '`Private`: no one else.',
  });
}

/**
 * An event's title: trimmed, and refused when that leaves it empty, so no
 * event is stored without a title (#1404).
 *
 * Shared with `UpdateEventDto`, which passes `optional`. That DTO can't
 * inherit `title` through `PartialType`, whose `IsOptional` lets `null`
 * through to the non-nullable column as a 500 (#1404).
 */
export function EventTitleProperty({ optional = false }: { optional?: boolean } = {}): PropertyDecorator {
  const description = 'Trimmed. Refused when empty.';

  return applyDecorators(
    ...(optional
      ? [ApiPropertyOptional({ description }), ValidateIf((_, value) => value !== undefined)]
      : [ApiProperty({ description })]),
    Transform(({ value }) => (typeof value === 'string' ? value.trim() : value)),
    IsString({ message: i18nValidationMessage('validation.isString') }),
    IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') }),
  );
}

/**
 * An enum field an event can leave out but never clear: `type` and
 * `schedulingMode`. Shared with `UpdateEventDto`, which names no default.
 *
 * `ValidateIf` rather than `IsOptional`, which skips null as well as
 * undefined: left out, the column default applies on a create and the stored
 * value stays on an update, but `null` is refused here instead of reaching the
 * non-nullable column as a 500 (#1404).
 */
export function EventEnumProperty<TEnum extends Record<string, string>>(
  enumType: TEnum,
  defaultValue?: TEnum[keyof TEnum],
): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({ enum: enumType, ...(defaultValue === undefined ? {} : { default: defaultValue }) }),
    ValidateIf((_, value) => value !== undefined),
    IsEnum(enumType, { message: i18nValidationMessage('validation.isEnum') }),
  );
}

export class CreateEventDto {
  @EventTitleProperty()
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

  @EventEnumProperty(EventType, EventType.CasualGathering)
  type?: EventType;

  @EventReachProperty(Reach.Friends)
  reach?: EventReach;

  @EventEnumProperty(EventSchedulingMode, EventSchedulingMode.Fixed)
  schedulingMode?: EventSchedulingMode;

  @ApiPropertyOptional({
    type: [String],
    maxItems: MAX_INVITE_USER_IDS,
    description:
      'User IDs to invite to the event at creation time. ' +
      'Each user is sent an invite offering the EventParticipant role, as `POST /events/:eventId/invites` sends one; ' +
      'they become an attendee only by accepting it, and until then they hold no event role and see no attendees. ' +
      "An id that names no person answers 404, and one the server's or the user's invite settings refuse answers 403. " +
      'Each invite counts against the daily event invite quota, which answers 402 once used up. ' +
      'Any refusal leaves nothing written: no event and no invite.',
  })
  // ValidateIf, not IsOptional, which let null through to the service as a
  // TypeError and a 500 (#1275).
  @ValidateIf((_, value) => value !== undefined)
  @IsArray({ message: i18nValidationMessage('validation.isArray') })
  @IsString({ each: true, message: i18nValidationMessage('validation.each.isString') })
  @ArrayMaxSize(MAX_INVITE_USER_IDS, { message: i18nValidationMessage('validation.arrayMaxSize') })
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

  @ClientRequestIdProperty('event', 'A repeat does not notify its invitees or fire its webhook again.')
  clientRequestId?: string;
}
