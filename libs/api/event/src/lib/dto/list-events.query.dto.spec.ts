import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListEventsQueryDto } from './list-events.query.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function parse(payload: Record<string, unknown>) {
  const dto = plainToInstance(ListEventsQueryDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return { dto, failed: errors.map((error) => error.property) };
}

describe('ListEventsQueryDto includeArchived', () => {
  // Implicit conversion reads any non-empty string as true, so `'false'`
  // would list archived events if the DTO trusted it (#795).
  it("reads the string 'false' as false", async () => {
    const { dto, failed } = await parse({ includeArchived: 'false' });

    expect(failed).toEqual([]);
    expect(dto.includeArchived).toBe(false);
  });

  it("reads the string 'true' as true (#795)", async () => {
    const { dto, failed } = await parse({ includeArchived: 'true' });

    expect(failed).toEqual([]);
    expect(dto.includeArchived).toBe(true);
  });

  it('leaves it out when not asked for (#795)', async () => {
    const { dto, failed } = await parse({});

    expect(failed).toEqual([]);
    expect(dto.includeArchived).toBeUndefined();
  });

  it('keeps the page contract it extends (#795)', async () => {
    const { dto, failed } = await parse({ page: '2', limit: '5', includeArchived: 'true' });

    expect(failed).toEqual([]);
    expect(dto.skip).toBe(5);
  });
});
