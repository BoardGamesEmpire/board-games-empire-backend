import { i18nValidationMessage } from '@bge/i18n-core';
import { applyDecorators } from '@nestjs/common';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsString, ValidateIf } from 'class-validator';

export interface ReachPropertyOptions<TReach extends string> {
  /** The rungs the field accepts: those a read rule serves for the model. */
  readonly reaches: readonly TReach[];
  /** Who each accepted rung admits, for the API reference. */
  readonly description: string;
  /** The column default, published on a create. An update names none. */
  readonly default?: TReach;
}

/**
 * An optional reach field that accepts only the rungs it is given: those a
 * read rule serves for the model. A row saved with another would claim
 * readers it doesn't have. The caller passes the rungs, so this needs no
 * database types.
 *
 * `ValidateIf` rather than `IsOptional`, which skips null as well as
 * undefined: left out, the column default applies, but an explicit null is
 * refused here instead of reaching a non-nullable column as a 500. An update
 * DTO declares the field itself, because `PartialType` would add `IsOptional`
 * back, and names no default: a PATCH that leaves it out keeps the stored
 * reach.
 */
export function ReachProperty<TReach extends string>({
  reaches,
  description,
  default: defaultReach,
}: ReachPropertyOptions<TReach>): PropertyDecorator {
  return applyDecorators(
    ApiPropertyOptional({
      enum: reaches,
      ...(defaultReach === undefined ? {} : { default: defaultReach }),
      description,
    }),
    ValidateIf((_, value) => value !== undefined),
    IsString({ message: i18nValidationMessage('validation.isString') }),
    IsIn(reaches, { message: i18nValidationMessage('validation.isIn') }),
  );
}
