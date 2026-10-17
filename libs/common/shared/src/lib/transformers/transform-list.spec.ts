import { plainToInstance } from 'class-transformer';
import { TransformList } from './transform-list';

class Sample {
  @TransformList()
  ids?: unknown;
}

describe('TransformList', () => {
  // Mirror the global ValidationPipe options (apps/api/src/main.ts), as the
  // TransformBoolean spec does.
  const toIds = (ids: unknown): unknown => plainToInstance(Sample, { ids }, { enableImplicitConversion: true }).ids;

  it('leaves the value undefined when the key is absent', () => {
    expect(plainToInstance(Sample, {}, { enableImplicitConversion: true }).ids).toBeUndefined();
  });

  it('splits a comma-separated value', () => {
    expect(toIds('a,b')).toEqual(['a', 'b']);
    expect(toIds('a')).toEqual(['a']);
  });

  it('takes a repeated param, splitting any value that is comma-separated itself', () => {
    expect(toIds(['a', 'b'])).toEqual(['a', 'b']);
    expect(toIds(['a,b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('trims each value', () => {
    expect(toIds('a, b')).toEqual(['a', 'b']);
    expect(toIds([' a ', 'b ,c'])).toEqual(['a', 'b', 'c']);
  });

  it('drops empty values, from a trailing comma or a blank param', () => {
    expect(toIds('a,')).toEqual(['a']);
    expect(toIds('a, ,b')).toEqual(['a', 'b']);
    expect(toIds('')).toEqual([]);
    expect(toIds(['', 'a'])).toEqual(['a']);
  });

  it('leaves a value that is neither a string nor an array for validation', () => {
    expect(toIds(5)).toBe(5);
    expect(toIds(null)).toBeNull();
    expect(toIds({ a: 'b' })).toEqual({ a: 'b' });
  });

  it('keeps an array item that is not a string as it is', () => {
    expect(toIds(['a', 5])).toEqual(['a', 5]);
  });
});
