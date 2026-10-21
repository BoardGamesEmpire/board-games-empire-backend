import { DISPLAY_NAME_MAX_LENGTH } from '@bge/auth';
import { Reach } from '@bge/database';
import { i18nValidationMessage } from '@bge/i18n';
import { ReachProperty } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, ValidateIf } from 'class-validator';

/** A bio is Markdown, sanitized before it is stored (#819). */
export const PROFILE_BIO_MAX_LENGTH = 2_000;
export const PROFILE_PRONOUNS_MAX_LENGTH = 40;
export const PROFILE_LOCATION_MAX_LENGTH = 100;
export const PROFILE_HOUSE_RULES_MAX_LENGTH = 200;
/** Dietary restrictions and accessibility needs. */
export const PROFILE_PRACTICAL_INFO_MAX_LENGTH = 500;
export const PROFILE_PLAYER_COUNT_MAX = 100;

/**
 * The reaches a profile read rule serves. `FriendsOfFriends` names readers no
 * rule serves until #496 defines a friend of a friend, so a profile saved with
 * it would claim readers it doesn't have.
 */
export const PROFILE_REACHES = [Reach.Public, Reach.Friends, Reach.Private] as const;
export type ProfileReach = (typeof PROFILE_REACHES)[number];

/** Trimmed, so padding is never stored. */
const trimmed = Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** Trimmed, and blank becomes null, so a field of only spaces is cleared rather than stored. */
const trimmedOrNull = Transform(({ value }) => (typeof value === 'string' ? value.trim() || null : value));

/**
 * Blank becomes null. Otherwise kept as sent: in Markdown, leading spaces can
 * carry meaning, such as an indented code block, so trimming them would change
 * the bio's structure.
 */
const blankAsNull = Transform(({ value }) => (typeof value === 'string' && value.trim() === '' ? null : value));

/**
 * The value as sent. Implicit conversion would turn any non-empty string into
 * true, so `"false"` would switch a setting on. Read as sent, a string is
 * refused as not a boolean.
 */
const asSent = Transform(({ obj, key }) => obj[key]);

/** Validated whenever it is sent, null included: its column keeps a value, so null is refused, not stored. */
const validatedWhenSent = ValidateIf((_, value) => value !== undefined);

/**
 * A user's edit to their own profile (#819). Every field is optional, and a
 * field left out is left as it is.
 *
 * The avatar can't be changed here until #829 decides how avatars reach a
 * client. The preferred game length and the favourite and disliked games,
 * categories and mechanics wait on #831. Both are refused like any other
 * unknown field.
 */
export class UpdateUserProfileDto {
  @ApiPropertyOptional({
    description: 'Trimmed. Refused when empty. New users start with their name, or their username (#818).',
    maxLength: DISPLAY_NAME_MAX_LENGTH,
  })
  @validatedWhenSent
  @trimmed
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @IsNotEmpty({ message: i18nValidationMessage('validation.isNotEmpty') })
  @MaxLength(DISPLAY_NAME_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  displayName?: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Markdown. Raw HTML and unsafe links are removed before it is stored. Blank or null clears it.',
    maxLength: PROFILE_BIO_MAX_LENGTH,
  })
  @IsOptional()
  @blankAsNull
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(PROFILE_BIO_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  bio?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Blank or null clears it.',
    maxLength: PROFILE_PRONOUNS_MAX_LENGTH,
  })
  @IsOptional()
  @trimmedOrNull
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(PROFILE_PRONOUNS_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  pronouns?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Blank or null clears it.',
    maxLength: PROFILE_LOCATION_MAX_LENGTH,
  })
  @IsOptional()
  @trimmedOrNull
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(PROFILE_LOCATION_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  location?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, minimum: 1, maximum: PROFILE_PLAYER_COUNT_MAX })
  @IsOptional()
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @Min(1, { message: i18nValidationMessage('validation.min') })
  @Max(PROFILE_PLAYER_COUNT_MAX, { message: i18nValidationMessage('validation.max') })
  preferredPlayerCount?: number | null;

  @ApiPropertyOptional()
  @validatedWhenSent
  @asSent
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  willingToTeach?: boolean;

  @ApiPropertyOptional()
  @validatedWhenSent
  @asSent
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  openToNewPlayers?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Blank or null clears it.',
    maxLength: PROFILE_HOUSE_RULES_MAX_LENGTH,
  })
  @IsOptional()
  @trimmedOrNull
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(PROFILE_HOUSE_RULES_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  houseRulesPreference?: string | null;

  @ApiPropertyOptional()
  @validatedWhenSent
  @asSent
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  hostingCapability?: boolean;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "Served to the profile's owner only (#830). Blank or null clears it.",
    maxLength: PROFILE_PRACTICAL_INFO_MAX_LENGTH,
  })
  @IsOptional()
  @trimmedOrNull
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(PROFILE_PRACTICAL_INFO_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  dietaryRestrictions?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "Served to the profile's owner only (#830). Blank or null clears it.",
    maxLength: PROFILE_PRACTICAL_INFO_MAX_LENGTH,
  })
  @IsOptional()
  @trimmedOrNull
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MaxLength(PROFILE_PRACTICAL_INFO_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  accessibilityNeeds?: string | null;

  @ReachProperty({
    reaches: PROFILE_REACHES,
    description:
      'Who may read the profile besides its owner, and so find it in search. `Public`: every signed-in user. ' +
      "`Friends`: the owner's accepted friends. `Private`: no one else. Staff read every profile whatever its reach.",
  })
  reach?: ProfileReach;

  @ApiPropertyOptional({
    description: 'Whether the profile is offered to user search. A profile not offered can still be read by id.',
  })
  @validatedWhenSent
  @asSent
  @IsBoolean({ message: i18nValidationMessage('validation.isBoolean') })
  isSearchable?: boolean;
}
