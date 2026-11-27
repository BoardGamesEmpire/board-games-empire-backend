import { i18nValidationMessage } from '@bge/i18n-core';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Exclude, Type } from 'class-transformer';
import type { ValidatorConstraintInterface } from 'class-validator';
import { IsInt, IsOptional, IsPositive, IsString, Max, Validate, ValidatorConstraint } from 'class-validator';
import type { KeysetPosition } from '../pagination/keyset-cursor';
import { decodeKeysetCursor } from '../pagination/keyset-cursor';
import { DEFAULT_MAX_PAGE_SIZE, DEFAULT_PAGE_SIZE } from './pagination-query.dto';

/**
 * Accepts only a cursor {@link decodeKeysetCursor} can read. A non-string
 * fails here as well as on `@IsString`: it is not a cursor either (#1597).
 */
@ValidatorConstraint({ name: 'isCursor', async: false })
class KeysetCursorConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && decodeKeysetCursor(value) !== null;
  }
}

/**
 * Shape-only base for keyset-paged query DTOs: `limit` plus the opaque
 * `cursor` a previous page returned as `pagination.nextCursor` (#1597).
 * `abstract` and cap-less for the reason `PaginationQueryDto` is: bind
 * the factory, {@link CappedCursorPaginationQueryDto}, never this.
 *
 * There is no `page`: the global pipe's `forbidNonWhitelisted` makes a stale
 * `?page=` a 400 rather than a parameter silently ignored.
 */
export abstract class CursorPaginationQueryDto {
  @Type(() => Number)
  @IsInt({ message: i18nValidationMessage('validation.isInt') })
  @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
  @IsOptional()
  limit?: number;

  // Declared here and re-declared nowhere, so its validators inherit cleanly.
  @ApiPropertyOptional({ description: "The previous page's pagination.nextCursor; omit for the first page" })
  @IsString({ message: i18nValidationMessage('validation.isString') })
  @Validate(KeysetCursorConstraint, { message: i18nValidationMessage('validation.isCursor') })
  @IsOptional()
  cursor?: string;

  /**
   * The resolved page size: what the read takes, and what the envelope echoes
   * as `pagination.limit`.
   */
  @Exclude()
  get pageSize(): number {
    return this.limit ?? DEFAULT_PAGE_SIZE;
  }

  /**
   * Where the page starts: the decoded `cursor`, or `undefined` on the first
   * page. Validation has already refused a cursor that does not decode, so
   * the read never sees one. A null, which a JSON frame can send past
   * `@IsOptional` (#564), is the first page as an absent cursor is.
   *
   * `@Exclude()` keeps class-transformer from writing a crafted `?after=`
   * onto this setter-less getter, as it does for `pageSize`.
   */
  @Exclude()
  get after(): KeysetPosition | undefined {
    if (typeof this.cursor !== 'string') {
      return undefined;
    }

    return decodeKeysetCursor(this.cursor) ?? undefined;
  }
}

/**
 * Builds a concrete {@link CursorPaginationQueryDto} whose `limit` is capped at
 * `maxLimit`, the keyset counterpart of `CappedPaginationQueryDto`. The
 * reasoning on that factory applies verbatim: this is the only `limit`-cap
 * declarer per chain, the whole `limit` chain is re-declared beside `@Max` so
 * `@IsPositive` survives, `declare` keeps the es2024 class field from
 * clobbering the transformed value, and `defaultPageSize` resolves `pageSize`
 * when the client omits `limit`.
 *
 *   export class ListWidgetsQueryDto extends CappedCursorPaginationQueryDto() {}
 */
export function CappedCursorPaginationQueryDto(
  maxLimit: number = DEFAULT_MAX_PAGE_SIZE,
  defaultPageSize: number = DEFAULT_PAGE_SIZE,
): new () => CursorPaginationQueryDto {
  if (defaultPageSize > maxLimit) {
    throw new RangeError(`defaultPageSize (${defaultPageSize}) cannot exceed maxLimit (${maxLimit})`);
  }

  class CappedCursorPaginationQuery extends CursorPaginationQueryDto {
    @ApiPropertyOptional({
      description: 'Maximum items per page',
      maximum: maxLimit,
      default: defaultPageSize,
    })
    @Type(() => Number)
    @IsInt({ message: i18nValidationMessage('validation.isInt') })
    @IsPositive({ message: i18nValidationMessage('validation.isPositive') })
    @Max(maxLimit, { message: i18nValidationMessage('validation.max') })
    @IsOptional()
    declare limit?: number;

    @Exclude()
    override get pageSize(): number {
      return this.limit ?? defaultPageSize;
    }
  }

  return CappedCursorPaginationQuery;
}
