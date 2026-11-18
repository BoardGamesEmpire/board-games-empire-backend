import { i18nValidationMessage } from '@bge/i18n-core';
import type { ValidationArguments, ValidationOptions, ValidatorConstraintInterface } from 'class-validator';
import { registerDecorator, ValidatorConstraint } from 'class-validator';

/**
 * Checks that a value is not less than another property's on the same
 * object, as a range's maximum is not less than its minimum (#719).
 *
 * It answers only that question: when either side is absent, null or not a
 * number, it passes, and the property's own validators say what's wrong.
 */
@ValidatorConstraint({ name: 'notLessThanProperty', async: false })
export class NotLessThanPropertyConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const [property]: string[] = args.constraints;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- class-validator types the object under validation as `object`, and TypeScript has no narrowing from `object` to an indexable record (#1321)
    const other: unknown = (args.object as Record<string, unknown>)[property];

    // `typeof` adds nothing at runtime, since `Number.isFinite` is false for
    // anything but a number, but unlike it, it narrows.
    if (typeof value !== 'number' || typeof other !== 'number' || !Number.isFinite(value) || !Number.isFinite(other)) {
      return true;
    }

    return value >= other;
  }
}

/**
 * Refuses a value less than `property`'s, naming `property` in the message
 * as `{constraints.0}`. Generic, so any range's maximum can take it.
 *
 * @param property  The property this one must not be less than.
 * @param validationOptions  Standard class-validator options; a `message` here replaces the catalog key.
 */
export function NotLessThanProperty(property: string, validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'notLessThanProperty',
      target: object.constructor,
      propertyName: propertyName.toString(),
      options: { message: i18nValidationMessage('validation.notLessThanProperty'), ...validationOptions },
      constraints: [property],
      validator: NotLessThanPropertyConstraint,
    });
  };
}
