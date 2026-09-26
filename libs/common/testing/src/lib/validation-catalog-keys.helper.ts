import type { ValidationError } from 'class-validator';

/**
 * Maps every failed constraint in `errors` to the catalog key its message
 * names, keyed `<property path>.<constraint>` (e.g. `'subject.isNotEmpty'`).
 * Nested errors are included under their dotted path.
 *
 * A decorator tagged with `i18nValidationMessage('validation.KEY')` reports its
 * message as nestjs-i18n's `KEY|<json args>` marker; only the edge
 * (`I18nValidationPipe` + `I18nValidationExceptionFilter`) turns it into copy,
 * so the key is everything before the first `|`. A bare decorator reports
 * class-validator's English default instead, which has no `|` and comes back
 * whole — so a spec asserting catalog keys fails on it.
 *
 * ```ts
 * expect(validationCatalogKeys(await validate(dto))).toEqual({
 *   'subject.isString': 'validation.isString',
 * });
 * ```
 */
export function validationCatalogKeys(errors: readonly ValidationError[]): Record<string, string> {
  const keys: Record<string, string> = {};

  const collect = (level: readonly ValidationError[], parentPath: string): void => {
    for (const error of level) {
      const path = parentPath ? `${parentPath}.${error.property}` : error.property;

      for (const [constraint, message] of Object.entries(error.constraints ?? {})) {
        keys[`${path}.${constraint}`] = message.split('|')[0];
      }

      collect(error.children ?? [], path);
    }
  };

  collect(errors, '');
  return keys;
}
