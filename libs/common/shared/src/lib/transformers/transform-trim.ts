import { Transform } from 'class-transformer';

/**
 * Property decorator that trims surrounding whitespace from a string body
 * field before validation, so a value of only spaces fails `IsNotEmpty`
 * rather than being stored (#1241). Anything that is not a string, `null`
 * included, passes through for the validators to judge.
 *
 * @example
 *   @TransformTrim()
 *   @IsString()
 *   @IsNotEmpty()
 *   name!: string;
 */
export const TransformTrim = (): PropertyDecorator =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));
