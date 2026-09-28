import { i18nValidationMessage, type I18nTranslations, type I18nValidationPath } from '@bge/i18n-core';
import type { ValidationArguments } from 'class-validator';
import { i18nValidationMessage as vendorI18nValidationMessage } from 'nestjs-i18n';

// `@bge/i18n-core` writes nestjs-i18n's marker itself so it never loads the
// runtime. These pin it to the vendor's own encoder: if nestjs-i18n changes the
// format its formatter parses, this fails before any message renders wrong.
describe('i18nValidationMessage (core) against nestjs-i18n', () => {
  function validationArguments(overrides: Partial<ValidationArguments>): ValidationArguments {
    return { value: undefined, constraints: [], targetName: 'Dto', object: {}, property: 'field', ...overrides };
  }

  // The vendor sees the constraints already joined: joining is ours, and is
  // what the round trip through `translateValidationErrors` covers.
  function vendorMarker(
    key: I18nValidationPath,
    args: Record<string, unknown> | undefined,
    validation: ValidationArguments,
  ): string {
    return vendorI18nValidationMessage<I18nTranslations>(
      key,
      args,
    )({
      ...validation,
      constraints: validation.constraints.map((constraint: unknown) =>
        Array.isArray(constraint) ? constraint.join(', ') : constraint,
      ),
    });
  }

  const cases: [string, I18nValidationPath, Record<string, unknown> | undefined, Partial<ValidationArguments>][] = [
    ['a number value and a scalar constraint', 'validation.min', undefined, { value: 0, constraints: [1] }],
    ['a string value carrying "|"', 'validation.isUUID', undefined, { value: 'a|b||c', constraints: [] }],
    ['an array constraint', 'validation.isIn', undefined, { value: 'upsert', constraints: [['create', 'delete']] }],
    ['named args', 'validation.isString', { hint: 'x', value: 'overridden' }, { value: 42, constraints: [] }],
    ['an object value', 'validation.isString', undefined, { value: { nested: 'a|b' }, constraints: [] }],
    ['no value', 'validation.maxJsonBytes', undefined, { value: undefined, constraints: [65536] }],
  ];

  it.each(cases)('writes the same marker for %s', (_case, key, args, overrides) => {
    const validation = validationArguments(overrides);

    expect(i18nValidationMessage(key, args)(validation)).toBe(vendorMarker(key, args, validation));
  });
});
