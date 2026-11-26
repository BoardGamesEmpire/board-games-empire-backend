import { i18nValidationMessage } from '@bge/i18n';
import type { ValidationOptions, ValidatorConstraintInterface } from 'class-validator';
import { registerDecorator, ValidatorConstraint } from 'class-validator';
import { parsePartialDate } from '../values/partial-date';

/** Passes a string that `parsePartialDate` reads: a year, a month or a day, and nothing else (#1231). */
@ValidatorConstraint({ name: 'isPartialDate', async: false })
export class IsPartialDateConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return typeof value === 'string' && parsePartialDate(value) !== null;
  }
}

/**
 * A date written as `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, as exact as the user
 * knows it (#1231). It judges the shape and the calendar only: whether the
 * date has come yet is the service's to decide, against its clock.
 *
 * @param validationOptions  Standard class-validator options; a `message` here replaces the catalog key.
 */
export function IsPartialDate(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isPartialDate',
      target: object.constructor,
      propertyName: propertyName.toString(),
      options: { message: i18nValidationMessage('validation.isPartialDate'), ...validationOptions },
      validator: IsPartialDateConstraint,
    });
  };
}
