import { i18nValidationMessage } from '@bge/i18n';
import { DefaultPaginationQueryDto } from '@bge/shared';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength, NotContains } from 'class-validator';
import { DeletedSortNeedsDeletedRows } from './deleted-sort-needs-deleted-rows.validator';

export const ADMIN_HOUSEHOLD_STATUSES = ['live', 'deleted', 'all'] as const;

export type AdminHouseholdStatus = (typeof ADMIN_HOUSEHOLD_STATUSES)[number];

export const ADMIN_HOUSEHOLD_SORTS = ['name', 'newest', 'members', 'deleted'] as const;

export type AdminHouseholdSort = (typeof ADMIN_HOUSEHOLD_SORTS)[number];

/**
 * Longest search term the list takes. Every request matches `q` against three
 * columns, in both the page read and the count, so the cap bounds that work
 * the way the page-size cap bounds `take` (#11). It is well past the longest
 * display name (64), so no term a person would type is refused (#419).
 */
export const ADMIN_HOUSEHOLD_SEARCH_MAX_LENGTH = 100;

/**
 * Query contract for `GET /admin/households`, the staff households list
 * (#419): the #230 page contract, plus which households, a search term and
 * the order.
 *
 * `status` and `q` narrow the set, and `sort` only orders it. Each sort value
 * names an order, not a column, and every order ends in the household id, as
 * `GET /games` orders its list, so a repeated request answers the same page
 * while the set is unchanged.
 */
export class AdminHouseholdListQueryDto extends DefaultPaginationQueryDto {
  @ApiPropertyOptional({
    enum: ADMIN_HOUSEHOLD_STATUSES,
    default: 'live',
    description:
      'Which households to list. live: households not deleted (the default). deleted: deleted households only, ' +
      'which staff can restore. all: both.',
  })
  @IsIn(ADMIN_HOUSEHOLD_STATUSES, { message: i18nValidationMessage('validation.isIn') })
  @IsOptional()
  status: AdminHouseholdStatus = 'live';

  @ApiPropertyOptional({
    minLength: 2,
    maxLength: ADMIN_HOUSEHOLD_SEARCH_MAX_LENGTH,
    description:
      'Search term, 2 to 100 characters once surrounding spaces are trimmed. Matches part of the household ' +
      'name, or of a member’s username or display name, ignoring case. `%`, `_` and `\\` match only themselves.',
  })
  // Trimmed before the length check, so a term of spaces is refused rather
  // than matching every name with two spaces in a row (#419).
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @MinLength(2, { message: i18nValidationMessage('validation.minLength') })
  @MaxLength(ADMIN_HOUSEHOLD_SEARCH_MAX_LENGTH, { message: i18nValidationMessage('validation.maxLength') })
  // Postgres refuses a null character in text, so a term with one would fail
  // in the database as a 500 rather than here as a 400 (#419).
  @NotContains('\u0000', { message: i18nValidationMessage('validation.noNullCharacter') })
  @IsOptional()
  q?: string;

  @ApiPropertyOptional({
    enum: ADMIN_HOUSEHOLD_SORTS,
    default: 'name',
    description:
      'Order of the list. name: A to Z (the default). newest: most recently created first. members: most ' +
      'members first. deleted: most recently deleted first, with live households last; needs status deleted ' +
      'or all.',
  })
  @IsIn(ADMIN_HOUSEHOLD_SORTS, { message: i18nValidationMessage('validation.isIn') })
  @DeletedSortNeedsDeletedRows()
  @IsOptional()
  sort: AdminHouseholdSort = 'name';
}
