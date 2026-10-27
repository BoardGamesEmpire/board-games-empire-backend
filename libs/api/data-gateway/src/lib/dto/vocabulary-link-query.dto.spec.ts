import { VocabularyLinkStatus } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VocabularyLinkQueryDto } from './vocabulary-link-query.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function parse(payload: Record<string, unknown>) {
  const dto = plainToInstance(VocabularyLinkQueryDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return { dto, failed: errors.map((error) => error.property) };
}

describe('VocabularyLinkQueryDto status (#718)', () => {
  it('reads a comma-separated list', async () => {
    const { dto, failed } = await parse({ status: 'Pending,Ignored' });

    expect(failed).toEqual([]);
    expect(dto.status).toEqual([VocabularyLinkStatus.Pending, VocabularyLinkStatus.Ignored]);
  });

  // Unresolved is a language link's status, not a vocabulary link's.
  it('refuses a value that names no status', async () => {
    await expect(parse({ status: 'Pending,Unresolved' })).resolves.toEqual(
      expect.objectContaining({ failed: ['status'] }),
    );
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
