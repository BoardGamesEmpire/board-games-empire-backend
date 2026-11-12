import { Reach } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ClientRequestIdProperty, ReachProperty } from '@bge/shared';
import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator';

const HOUSEHOLD_REACHES = [Reach.Private, Reach.Friends] as const;
export type HouseholdReach = (typeof HOUSEHOLD_REACHES)[number];

/**
 * A household's reach: Private or Friends only, the rungs a household read
 * rule serves. `Public` waits on #231, which decides what someone outside a
 * household sees of it (#495). So does `FriendsOfFriends`, which widens a
 * roster beyond friends and needs an answer to whose block vetoes in a
 * household of many members (#496), and so does `ExtendedNetwork`, for the
 * same reasons (#497). Shared with `UpdateHouseholdDto`, which names no
 * default.
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

/**
 * A household's name: trimmed, and refused when that leaves it empty, so no
 * household is stored without a name (#884).
 *
 * Shared with `UpdateHouseholdDto`, which passes `optional`. That DTO can't
 * inherit `name` through `PartialType`, whose `IsOptional` lets `null` through
 * to the non-nullable column (#788). So it declares `name` again, and
 * this keeps the trim and the empty-name check on both DTOs.
 */
export function HouseholdNameProperty({ optional = false }: { optional?: boolean } = {}): PropertyDecorator {
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

export class CreateHouseholdDto {
  @HouseholdNameProperty()
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
