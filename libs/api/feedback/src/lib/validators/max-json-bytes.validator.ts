import { i18nValidationMessage } from '@bge/i18n';
import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

/**
 * Validates that the UTF-8 byte size of `JSON.stringify(value)` does not
 * exceed the configured maximum.
 *
 * Exists primarily for the `breadcrumbs` field on `CreateFeedbackReportDto`,
 * where the client emits a bounded ring buffer of structured entries and we
 * need a transport-level ceiling that is robust to multi-byte characters
 * (emoji in messages, non-Latin loggerName segments). Using UTF-8 byte size
 * — not JS string `.length` — keeps the metric aligned with the bytes the
 * database column and any downstream sink will actually carry.
 *
 * Null and undefined values are treated as absent and validate trivially;
 * pair with `@IsOptional()` (or `@ValidateIf`) at the call site to control
 * presence semantics.
 *
 * Values containing circular references fail validation rather than
 * throwing through the validator — failing loudly at the API boundary is
 * the desired pre-alpha behavior.
 */
@ValidatorConstraint({ name: 'maxJsonBytes', async: false })
export class MaxJsonBytesConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    if (value === undefined || value === null) {
      return true;
    }

    const [maxBytes] = args.constraints as [number];

    let serialized: string;
    try {
      serialized = JSON.stringify(value);
    } catch {
      return false;
    }
    if (serialized === undefined) {
      // Pure-function values, BigInts, etc. — not JSON-representable.
      return false;
    }

    return Buffer.byteLength(serialized, 'utf8') <= maxBytes;
  }

  defaultMessage(args: ValidationArguments): string {
    // `i18nValidationMessage` JSON-serializes `args.value` into the encoded
    // marker, but the value here is the (potentially oversized or even
    // non-serializable — BigInt/circular) payload we just rejected, and the
    // catalog string only interpolates `{property}` and `{constraints.0}`
    // (maxBytes). Strip `value` so building the message can never throw.
    return i18nValidationMessage('validation.maxJsonBytes')({ ...args, value: undefined });
  }
}

/**
 * Property decorator counterpart to `MaxJsonBytesConstraint`. Caps the
 * UTF-8 byte size of `JSON.stringify(value)`.
 *
 * @param maxBytes  Inclusive upper bound, in UTF-8 bytes.
 * @param validationOptions  Standard class-validator options (each, groups, message, ...).
 */
export function MaxJsonBytes(maxBytes: number, validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'maxJsonBytes',
      target: object.constructor,
      propertyName: propertyName.toString(),
      options: validationOptions,
      constraints: [maxBytes],
      validator: MaxJsonBytesConstraint,
    });
  };
}
