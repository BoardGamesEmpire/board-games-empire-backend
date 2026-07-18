import { i18nValidationMessage as baseI18nValidationMessage } from 'nestjs-i18n';
import type { I18nPath, I18nTranslations } from './generated/i18n.generated';

/**
 * The `validation.*` subset of {@link I18nPath}. Restricting validation markers
 * to this namespace keeps decorator messages pointed at the validation catalog
 * (and documents that intent at the type level). Widen here if a decorator ever
 * needs a shared `common.*` key.
 */
export type I18nValidationPath = Extract<I18nPath, `validation.${string}`>;

/**
 * `@bge/i18n` facade over nestjs-i18n's `i18nValidationMessage`, pre-bound to the
 * generated {@link I18nTranslations} so DTOs import translation tooling from one
 * place (mirrors {@link t} for exceptions). Domain DTOs never import
 * `nestjs-i18n` directly.
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
 */
export function i18nValidationMessage(key: I18nValidationPath, args?: Record<string, unknown>) {
  return baseI18nValidationMessage<I18nTranslations>(key, args);
}
