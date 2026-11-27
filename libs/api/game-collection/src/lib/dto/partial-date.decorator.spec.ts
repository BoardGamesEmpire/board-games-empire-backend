import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { IsPartialDate } from './partial-date.decorator';

/** A DTO field as the routes declare one, so implicit conversion reads its `string` type as the pipe does. */
class Sample {
  @IsPartialDate()
  on!: string;
}

/** Mirrors the global validation pipe: implicit conversion, and no field outside the DTO (#1231). */
async function messagesFor(on: unknown): Promise<string[]> {
  const errors = await validate(plainToInstance(Sample, { on }, { enableImplicitConversion: true }), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });

  return errors.flatMap((error) => Object.values(error.constraints ?? {}));
}

describe('IsPartialDate (#1231)', () => {
  it.each(['2019', '2019-03', '2019-03-02', '2024-02-29'])('accepts %s', async (on) => {
    await expect(messagesFor(on)).resolves.toEqual([]);
  });

  it.each(['2019-3', '19', '2019-02-29', '2019-03-02T00:00Z', ''])('refuses %j', async (on) => {
    await expect(messagesFor(on)).resolves.toHaveLength(1);
  });

  // Implicit conversion turns a JSON number into the string the field
  // declares before the check runs, so the year 2019 sent as a number reads
  // as "2019", and 19 as "19", which is no year (#1231).
  it('reads a JSON number as the string implicit conversion makes of it', async () => {
    await expect(messagesFor(2019)).resolves.toEqual([]);
    await expect(messagesFor(19)).resolves.toHaveLength(1);
  });

  it.each([true, null, undefined, {}])('refuses the non-string %j', async (on) => {
    await expect(messagesFor(on)).resolves.toHaveLength(1);
  });
});
