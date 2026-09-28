import type { I18nPath } from './generated/i18n.generated';

/**
 * The `validation.*` subset of {@link I18nPath}. Restricting validation markers
 * to this namespace keeps decorator messages pointed at the validation catalog
 * (and documents that intent at the type level). Widen here if a decorator ever
 * needs a shared `common.*` key.
 */
export type I18nValidationPath = Extract<I18nPath, `validation.${string}`>;

/**
 * The part of class-validator's `ValidationArguments` a marker reads. Typed
 * structurally so this lib takes no dependency on class-validator; a message
 * function accepting it is still assignable to a decorator's `message` option.
 */
export interface ValidationMessageArguments {
  readonly value: unknown;
  readonly constraints?: readonly unknown[];
}

/**
 * A decorator message that defers translation to the edge: it names a
 * `validation.*` catalog key instead of carrying English.
 *
 * ```ts
 * import { i18nValidationMessage } from '@bge/i18n';
 * import { IsString } from 'class-validator';
 *
 * class Dto {
 *   @IsString({ message: i18nValidationMessage('validation.isString') })
 *   name: string;
 * }
 * ```
 *
 * `key` is checked against the `validation.*` catalog — an unknown key fails
 * `tsc`. The catalog string may interpolate `{property}`, `{value}`, and
 * positional `{constraints.0}`; extra named args passed here are merged in too.
 * The marker only becomes a translated string once the request hits
 * `I18nValidationPipe` + `I18nValidationExceptionFilter` (registered in the
 * app); calling `class-validator`'s `validate()` directly yields the raw marker.
 *
 * The marker is nestjs-i18n's own format, `key|{"value":…,"constraints":[…],…args}`,
 * with `|` stripped from a string value so the first `|` still separates the
 * key. It is written here rather than by calling nestjs-i18n, so a lib can mark
 * its messages without loading the runtime (#503). A spec in `@bge/i18n` pins
 * it byte for byte to the vendor's function fed constraints joined as below, so
 * a change to either the format or the join fails it.
 *
 * An array constraint (`@IsIn`'s values, `@IsEnum`'s entries) is joined with
 * ", " before encoding, as class-validator does for its own defaults. The
 * catalog formatter would otherwise print it with bare commas.
 */
export function i18nValidationMessage(key: I18nValidationPath, args?: Record<string, unknown>) {
  return (validationArguments: ValidationMessageArguments): string => {
    const value =
      typeof validationArguments.value === 'string'
        ? validationArguments.value.replace(/\|/g, '')
        : validationArguments.value;
    const constraints = validationArguments.constraints?.map((constraint) =>
      Array.isArray(constraint) ? constraint.join(', ') : constraint,
    );

    return `${key}|${JSON.stringify({ value, constraints, ...args })}`;
  };
}
