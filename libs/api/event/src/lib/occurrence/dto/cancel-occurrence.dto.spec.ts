import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EVENT_CANCEL_MAX_REASON_LENGTH } from '../../constants/event-cancel.constant';
import { CancelOccurrenceDto } from './cancel-occurrence.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function parse(payload: Record<string, unknown>) {
  const dto = plainToInstance(CancelOccurrenceDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return { dto, failed: errors.map((error) => error.property) };
}

// A date's cancel takes a reason on the same terms as its event's (#795).
describe('CancelOccurrenceDto', () => {
  it('takes no reason at all (#795)', async () => {
    await expect(parse({})).resolves.toEqual(expect.objectContaining({ failed: [] }));
  });

  it('takes a reason up to its limit (#795)', async () => {
    const { dto, failed } = await parse({ reason: 'x'.repeat(EVENT_CANCEL_MAX_REASON_LENGTH) });

    expect(failed).toEqual([]);
    expect(dto.reason).toHaveLength(EVENT_CANCEL_MAX_REASON_LENGTH);
  });

  it.each<[string, unknown]>([
    ['an empty reason', ''],
    ['a reason past its limit', 'x'.repeat(EVENT_CANCEL_MAX_REASON_LENGTH + 1)],
  ])('refuses %s (#795)', async (_, reason) => {
    await expect(parse({ reason })).resolves.toEqual(expect.objectContaining({ failed: ['reason'] }));
  });
});
