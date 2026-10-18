import { LanguageLinkStatus } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LanguageLinkQueryDto } from './language-link-query.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function parse(payload: Record<string, unknown>) {
  const dto = plainToInstance(LanguageLinkQueryDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return { dto, failed: errors.map((error) => error.property) };
}

describe('LanguageLinkQueryDto status', () => {
  it('reads a comma-separated list', async () => {
    const { dto, failed } = await parse({ status: 'Pending,Unresolved' });

    expect(failed).toEqual([]);
    expect(dto.status).toEqual([LanguageLinkStatus.Pending, LanguageLinkStatus.Unresolved]);
  });

  it('refuses a value that names no status', async () => {
    await expect(parse({ status: 'Pending,Bogus' })).resolves.toEqual(expect.objectContaining({ failed: ['status'] }));
  });

  // `?status=` reads as an empty list, which would list nothing at all.
  it('refuses an empty filter', async () => {
    await expect(parse({ status: '' })).resolves.toEqual(expect.objectContaining({ failed: ['status'] }));
  });

  it('leaves the status out when none is asked for', async () => {
    const { dto, failed } = await parse({});

    expect(failed).toEqual([]);
    expect(dto.status).toBeUndefined();
  });
});
