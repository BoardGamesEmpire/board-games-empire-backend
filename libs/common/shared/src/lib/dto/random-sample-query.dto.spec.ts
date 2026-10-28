import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DEFAULT_SAMPLE_SIZE, RandomSampleQueryDto } from './random-sample-query.dto';

/**
 * `size` is how many random games `GET /games/random` and
 * `GET /households/game-pool/random` return (#960, #961).
 */
describe('RandomSampleQueryDto', () => {
  // Mirror the global ValidationPipe transform (query-string values arrive as
  // strings), matching the CappedPaginationQueryDto spec.
  const toDto = (plain: Record<string, unknown>) =>
    plainToInstance(RandomSampleQueryDto, plain, { enableImplicitConversion: true });

  const errorsFor = async (plain: Record<string, unknown>) =>
    (await validate(toDto(plain))).filter((error) => error.property === 'size');

  it('defaults to 10 games when size is left out', async () => {
    expect(toDto({}).size).toBe(DEFAULT_SAMPLE_SIZE);
    expect(DEFAULT_SAMPLE_SIZE).toBe(10);
    expect(await errorsFor({})).toHaveLength(0);
  });

  it.each(['1', '50'])('accepts size=%s', async (size) => {
    expect(await errorsFor({ size })).toHaveLength(0);
    expect(toDto({ size }).size).toBe(Number(size));
  });

  // #960: a size outside 1–50 is refused, never clamped or read as the default.
  it.each([
    ['zero', '0'],
    ['one past the cap', '51'],
    ['a negative number', '-1'],
    ['a fraction', '2.5'],
    ['a word', 'abc'],
    ['an empty value', ''],
    ['a repeated parameter', ['5', '6']],
  ])('refuses %s', async (_label, size) => {
    expect(await errorsFor({ size })).not.toHaveLength(0);
  });

  // The messages are the ones `limit` uses, so the edge renders them in the
  // request's locale. A word fails every numeric check at once.
  it('names a validation catalog key for every failure', async () => {
    const [error] = await errorsFor({ size: 'abc' });
    const keys = Object.fromEntries(
      Object.entries(error.constraints ?? {}).map(([constraint, message]) => [constraint, message.split('|')[0]]),
    );

    expect(keys).toEqual({
      isInt: 'validation.isInt',
      isPositive: 'validation.isPositive',
      max: 'validation.max',
    });
  });
});
