import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApprovePluginUpdateDto } from './approve-plugin-update.dto';

describe('ApprovePluginUpdateDto', () => {
  // Mirrors the global pipe (apps/api/src/main.ts), which converts implicitly.
  const toDto = (plain: Record<string, unknown>): ApprovePluginUpdateDto =>
    plainToInstance(ApprovePluginUpdateDto, plain, { enableImplicitConversion: true });

  const invalidProperties = async (plain: Record<string, unknown>): Promise<string[]> =>
    (await validate(toDto(plain))).map((error) => error.property);

  it('accepts a staging id, with or without the confirmation set (#357)', async () => {
    await expect(invalidProperties({ stagingId: 'staging-a' })).resolves.toEqual([]);
    await expect(
      invalidProperties({ stagingId: 'staging-a', confirmCriticalSlugs: ['user:impersonate'] }),
    ).resolves.toEqual([]);
  });
});
