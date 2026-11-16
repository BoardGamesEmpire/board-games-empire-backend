import { isPlainJsonObject } from './is-plain-json-object';

describe('isPlainJsonObject (#393)', () => {
  it.each([
    ['an empty object', {}],
    ['an object with a key', { a: 1 }],
  ])('accepts %s', (_name, value) => {
    expect(isPlainJsonObject(value)).toBe(true);
  });

  it.each([
    ['null', null],
    ['an empty array', []],
    ['an array holding an object', [{}]],
    ['a string', 'x'],
    ['a number', 0],
    ['a boolean', true],
    ['undefined', undefined],
  ])('rejects %s', (_name, value) => {
    expect(isPlainJsonObject(value)).toBe(false);
  });
});
