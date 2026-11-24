import { Transform } from 'class-transformer';

/**
 * The value as the request sent it, not as the global pipe's implicit
 * conversion left it: that makes the number 5 the string '5', the string '90'
 * the number 90, and the string 'false' `true`. Read as sent, a value of the
 * wrong kind fails its validator (#1418).
 */
export const asSent = Transform(({ obj, key }: { key: string; obj: Record<string, unknown> }): unknown => obj[key]);

/** A string trimmed, read as sent: a number stays a number and fails `IsString`, rather than becoming one (#1418). */
export const trimmedAsSent = Transform(({ obj, key }: { key: string; obj: Record<string, unknown> }): unknown => {
  const value = obj[key];

  return typeof value === 'string' ? value.trim() : value;
});
