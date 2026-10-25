import { Reach } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ClientRequestIdProperty, ReachProperty } from '@bge/shared';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

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

  @ClientRequestIdProperty('household')
  clientRequestId?: string;
}
