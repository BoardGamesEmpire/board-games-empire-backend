import { Transform } from 'class-transformer';

/**
 * Property decorator for boolean query/body params validated by a NestJS
 * `ValidationPipe` with `transform: true` (and, in this codebase,
 * `enableImplicitConversion: true`).
 *
 * Why this exists: implicit conversion — and `@Type(() => Boolean)` — coerce
 * with `Boolean(value)`, which is broken for query strings because
 * `Boolean('false') === true`. So `?flag=false` would arrive as `true`.
 *
 * This reads the *raw* source value (`obj[key]`), bypassing that coercion, and
 * treats only the literal string `'true'` (case-insensitive) or boolean `true`
 * as true — everything else present is `false`. Mirrors `isTrue` from
 * `@bge/env` without coupling this foundational lib to env's import-time
 * side effects.
 *
 * When the param is absent the value is left `undefined`, so callers can apply
 * their own default (e.g. `?? true`) or omit the filter entirely.
 *
 * @example
 *   @IsOptional()
 *   @IsBoolean()
 *   @TransformBoolean()
 *   systemSupported?: boolean;
 */
export const TransformBoolean = () =>
  Transform(({ obj, key }) => {
    const raw = obj[key];
    return raw === undefined ? undefined : raw?.toString().toLowerCase() === 'true';
  });
