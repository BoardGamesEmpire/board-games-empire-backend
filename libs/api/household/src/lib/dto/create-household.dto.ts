import { Reach } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ReachProperty } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { HOUSEHOLD_MAX_CLIENT_REQUEST_ID_LENGTH } from '../constants/household.constants';

const HOUSEHOLD_REACHES = [Reach.Private, Reach.Friends] as const;
export type HouseholdReach = (typeof HOUSEHOLD_REACHES)[number];

/**
 * A household's reach: Private or Friends only, the rungs a household read
 * rule serves. `Public` waits on #231, which decides what someone outside a
 * household sees of it (#495). So does `FriendsOfFriends`, which widens a
 * roster beyond friends and needs an answer to whose block vetoes in a
 * household of many members (#496). Shared with `UpdateHouseholdDto`, which
 * names no default.
 */
export function HouseholdReachProperty(defaultReach?: HouseholdReach): PropertyDecorator {
  return ReachProperty({
    reaches: HOUSEHOLD_REACHES,
    default: defaultReach,
    description:
      'Who may read the household and its roster besides its members. `Private`: no one. `Friends`: each ' +
      "member's friends.",
  });
}

export class CreateHouseholdDto {
  @ApiProperty()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  name!: string;

  @HouseholdReachProperty(Reach.Private)
  reach?: HouseholdReach;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  image?: string;

  @ApiPropertyOptional({ description: "IETF BCP 47 language tag, e.g. 'en', 'pt-BR', 'zh-Hant'" })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  language?: string;

  @ApiPropertyOptional({
    description:
      'Client-supplied idempotency key, scoped per user. A repeat POST with the same key returns the ' +
      'ORIGINAL household (same id, same 201 envelope) instead of creating a duplicate — the payload of ' +
      'the repeat is ignored (first writer wins). Keys are retained indefinitely. The Flutter client ' +
      'sends its queued operation `localId` (a cuid2), but any stable opaque string is accepted. ' +
      'Surrounding whitespace is trimmed; a blank key is rejected rather than silently ignored.',
    minLength: 1,
    maxLength: HOUSEHOLD_MAX_CLIENT_REQUEST_ID_LENGTH,
  })
  @IsOptional()
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MinLength(1, { message: i18nValidationMessage('validation.minLength') })
  @MaxLength(HOUSEHOLD_MAX_CLIENT_REQUEST_ID_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  // Trim before length validation so a whitespace-only key collapses to '' and
  // fails MinLength (a 400) rather than reaching the service, where it would be
  // normalized away and silently cost the caller its idempotency guarantee.
  // Trimming also makes retries that differ only in padding hash to one key.
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  clientRequestId?: string;
}
