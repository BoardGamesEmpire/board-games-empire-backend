import { Transform } from 'class-transformer';

/**
 * Property decorator for a query param that takes a list: comma-separated
 * (`?ids=a,b`), repeated (`?ids=a&ids=b`), or both. Each value is trimmed and
 * empty ones dropped, so a hand-typed `a, b,` is `['a', 'b']`.
 *
 * A value that's neither a string nor an array is left as it is, for the
 * property's validators to refuse, and an absent param stays `undefined`.
 *
 * @example
 *   @IsOptional()
 *   @IsArray()
 *   @IsString({ each: true })
 *   @TransformList()
 *   gatewayIds?: string[];
 */
export const TransformList = () =>
  Transform(({ value }) => {
    if (typeof value !== 'string' && !Array.isArray(value)) {
      return value;
    }

    return ([] as unknown[])
      .concat(value)
      .flatMap((item) => (typeof item === 'string' ? item.split(',').map((part) => part.trim()) : [item]))
      .filter((item) => item !== '');
  });
