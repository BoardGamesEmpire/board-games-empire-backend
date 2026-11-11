import { Transform } from 'class-transformer';

/**
 * The range a search filter's bound can take: the proto carries each as an
 * int32, which would wrap a larger one into some other value (#719, #869).
 * The offered-games read takes the same bounds, so a range means one thing
 * on both (#1187).
 */
export const INT32_MIN = -(2 ** 31);
export const INT32_MAX = 2 ** 31 - 1;

/**
 * Converts only a number or a numeric string into a range's bound, and reads
 * a blank one as absent. Implicit conversion would make a blank string,
 * `false` or `[]` 0 and `true` 1, each a bound like any other, so a
 * `?publishYearMin=` or `?playTimeMax=` left empty, or a frame's `false`,
 * would silently narrow the search by it. Anything else stays as sent, for
 * `@IsInt` to refuse (#719, #869).
 */
export const TransformRangeBound = () =>
  Transform(({ obj, key, value }) => {
    const raw: unknown = obj[key];
    if (typeof raw === 'string') return raw.trim() === '' ? undefined : value;
    return typeof raw === 'number' ? value : raw;
  });
