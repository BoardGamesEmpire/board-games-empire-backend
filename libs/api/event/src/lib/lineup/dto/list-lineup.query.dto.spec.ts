import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListLineupQueryDto } from './list-lineup.query.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function parse(payload: Record<string, unknown>) {
  const dto = plainToInstance(ListLineupQueryDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return {
    dto,
    failed: errors.map((error) => error.property),
    constraints: errors.flatMap((error) => Object.keys(error.constraints ?? {})),
  };
}

describe('ListLineupQueryDto (#799)', () => {
  it('reads the whole lineup without occurrenceId, and one date with it (#799)', async () => {
    const whole = await parse({});

    expect(whole.failed).toEqual([]);
    expect(whole.dto.occurrenceId).toBeUndefined();

    const narrowed = await parse({ occurrenceId: 'occ-1' });

    expect(narrowed.failed).toEqual([]);
    expect(narrowed.dto.occurrenceId).toBe('occ-1');
  });

  // `?occurrenceId=a&occurrenceId=b` arrives as an array: one date at a time.
  it('refuses an occurrenceId that is not a string (#799)', async () => {
    const { failed, constraints } = await parse({ occurrenceId: ['occ-1', 'occ-2'] });

    expect(failed).toEqual(['occurrenceId']);
    expect(constraints).toEqual(['isString']);
  });

  // `?occurrenceId=` names no date, and would list nothing rather than the
  // whole lineup: refused, so the client learns its filter is malformed.
  it('refuses a blank occurrenceId (#799)', async () => {
    const { failed, constraints } = await parse({ occurrenceId: '' });

    expect(failed).toEqual(['occurrenceId']);
    expect(constraints).toEqual(['isNotEmpty']);
  });

  it('refuses an unknown query parameter (#799)', async () => {
    const { failed } = await parse({ attendeeIds: 'att-1' });

    expect(failed).toEqual(['attendeeIds']);
  });

  it('keeps the page contract it extends (#799)', async () => {
    const { dto, failed } = await parse({ page: '2', limit: '5', occurrenceId: 'occ-1' });

    expect(failed).toEqual([]);
    expect(dto.skip).toBe(5);
  });
});
