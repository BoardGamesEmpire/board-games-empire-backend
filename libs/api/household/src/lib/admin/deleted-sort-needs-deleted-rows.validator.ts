import { i18nValidationMessage } from '@bge/i18n';
import {
  registerDecorator,
  type ValidationArguments,
  type ValidationOptions,
  ValidatorConstraint,
  type ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Refuses the "most recently deleted" order over live households only
 * (#419). Every row under `status=live` has no deletion date, so the order
 * would mean nothing, and a client asking for it has forgotten `status`.
 *
 * It answers only that question. Any other value passes, and the property's
 * own validators say what is wrong with it.
 */
@ValidatorConstraint({ name: 'deletedSortNeedsDeletedRows', async: false })
export class DeletedSortNeedsDeletedRowsConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const { status } = args.object as { status?: unknown };

    return !(value === 'deleted' && status === 'live');
  }
}

/**
 * Applied to the list's `sort`: `deleted` needs `status` to be `deleted` or
 * `all`. A `status` left out is `live`, its default, so it is refused too.
 *
 * Lives beside the households list rather than in `@bge/shared`, because the
 * rule is this list's and nobody else's.
 *
 * @param validationOptions  Standard class-validator options; a `message` here replaces the catalog key.
 */
export function DeletedSortNeedsDeletedRows(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'deletedSortNeedsDeletedRows',
      target: object.constructor,
      propertyName: propertyName.toString(),
      options: { message: i18nValidationMessage('validation.deletedSortNeedsDeletedRows'), ...validationOptions },
      validator: DeletedSortNeedsDeletedRowsConstraint,
    });
  };
}
