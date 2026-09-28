import { i18nValidationMessage } from './validation-message';

describe('i18nValidationMessage', () => {
  it('writes the key, then the value and constraints as JSON', () => {
    expect(i18nValidationMessage('validation.min')({ value: 0, constraints: [1] })).toBe(
      'validation.min|{"value":0,"constraints":[1]}',
    );
  });

  it('joins an array constraint with ", "', () => {
    expect(i18nValidationMessage('validation.isIn')({ value: 'upsert', constraints: [['create', 'update']] })).toBe(
      'validation.isIn|{"value":"upsert","constraints":["create, update"]}',
    );
  });

  it('strips "|" from a string value, so the first "|" still ends the key', () => {
    const marker = i18nValidationMessage('validation.isUUID')({ value: 'a|b|c', constraints: [] });

    expect(marker).toBe('validation.isUUID|{"value":"abc","constraints":[]}');
    expect(marker.slice(0, marker.indexOf('|'))).toBe('validation.isUUID');
  });

  it('merges named args after the value and constraints', () => {
    expect(i18nValidationMessage('validation.isString', { hint: 'x' })({ value: 42, constraints: [] })).toBe(
      'validation.isString|{"value":42,"constraints":[],"hint":"x"}',
    );
  });

  it('leaves out constraints and a value a validator does not pass', () => {
    expect(i18nValidationMessage('validation.isString')({ value: undefined })).toBe('validation.isString|{}');
  });
});
