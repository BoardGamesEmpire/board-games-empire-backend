import { Transform } from 'class-transformer';

/**
 * Property decorator that reads a body field as the request sent it, not as
 * the global pipe's implicit conversion left it (#1418). That conversion turns
 * the number 5 into the string '5', the string '90' into the number 90, and
 * the string 'false' into `true` (`Boolean('false')`). Read as sent, a value
 * of the wrong kind fails its validator instead of passing as another kind.
 *
 * @example
 *   @TransformAsSent()
 *   @IsOptional()
 *   @IsBoolean()
 *   enabled?: boolean;
 */
export const TransformAsSent = (): PropertyDecorator =>
  Transform(({ obj, key }: { key: string; obj: Record<string, unknown> }): unknown => obj[key]);

/**
 * Property decorator that trims a string body field read as sent (#1418): a
 * number stays a number and fails `IsString`, rather than becoming one. As with
 * `TransformTrim`, a value of only spaces becomes '' for `IsNotEmpty` to
 * refuse, and anything that isn't a string passes through for the validators.
 *
 * @example
 *   @TransformTrimmedAsSent()
 *   @IsString()
 *   @IsNotEmpty()
 *   name!: string;
 */
export const TransformTrimmedAsSent = (): PropertyDecorator =>
  Transform(({ obj, key }: { key: string; obj: Record<string, unknown> }): unknown => {
    const value = obj[key];

    return typeof value === 'string' ? value.trim() : value;
  });
