import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RejectPluginUpdateDto } from './reject-plugin-update.dto';

describe('RejectPluginUpdateDto', () => {
  // Mirrors the global pipe (apps/api/src/main.ts), which converts implicitly.
  const toDto = (plain: Record<string, unknown>): RejectPluginUpdateDto =>
    plainToInstance(RejectPluginUpdateDto, plain, { enableImplicitConversion: true });

  const invalidProperties = async (plain: Record<string, unknown>): Promise<string[]> =>
    (await validate(toDto(plain))).map((error) => error.property);

  it('requires the staging id the staged-update read reported (#357)', async () => {
    await expect(invalidProperties({})).resolves.toEqual(['stagingId']);
  });

  it('refuses an empty staging id (#357)', async () => {
    await expect(invalidProperties({ stagingId: '' })).resolves.toEqual(['stagingId']);
  });

  it('accepts a staging id (#357)', async () => {
    await expect(invalidProperties({ stagingId: 'staging-a' })).resolves.toEqual([]);
  });
});
