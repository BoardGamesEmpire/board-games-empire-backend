import { validate } from 'class-validator';
import { NotLessThanProperty } from './not-less-than-property.validator';

class Range {
  from?: number | null;

  @NotLessThanProperty('from')
  to?: number | null;
}

const range = (from: unknown, to: unknown): Range => Object.assign(new Range(), { from, to });

describe('@NotLessThanProperty', () => {
  it('passes when either side is absent or null', async () => {
    for (const [from, to] of [
      [undefined, 5],
      [5, undefined],
      [null, 5],
      [5, null],
      [undefined, undefined],
    ]) {
      await expect(validate(range(from, to))).resolves.toEqual([]);
    }
  });

  it('passes when equal, and when above the other property, negatives included', async () => {
    await expect(validate(range(1990, 1990))).resolves.toEqual([]);
    await expect(validate(range(1990, 2000))).resolves.toEqual([]);
    await expect(validate(range(-500, -100))).resolves.toEqual([]);
  });

  it('fails with validation.notLessThanProperty naming the other property when below it', async () => {
    const [error, ...others] = await validate(range(2000, 1990));

    // The key is the part of the `key|{…}` marker before the first `|`, read
    // here because `@bge/testing`, which holds the helper, depends on this lib.
    const [key, args] = (error?.constraints?.['notLessThanProperty'] ?? '').split('|');

    expect(others).toEqual([]);
    expect(error?.property).toBe('to');
    expect(key).toBe('validation.notLessThanProperty');
    expect(JSON.parse(args ?? '{}')).toMatchObject({ constraints: ['from'] });
  });

  it("stays silent when either side isn't a number, which its own validators report", async () => {
    await expect(validate(range('abc', 1990))).resolves.toEqual([]);
    await expect(validate(range(2000, Number.NaN))).resolves.toEqual([]);
  });
});
