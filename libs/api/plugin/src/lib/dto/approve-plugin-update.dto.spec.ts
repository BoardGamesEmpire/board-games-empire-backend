import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApprovePluginUpdateDto } from './approve-plugin-update.dto';

describe('ApprovePluginUpdateDto', () => {
  // Mirrors the global pipe (apps/api/src/main.ts), which converts implicitly.
  const toDto = (plain: Record<string, unknown>): ApprovePluginUpdateDto =>
    plainToInstance(ApprovePluginUpdateDto, plain, { enableImplicitConversion: true });

  const invalidProperties = async (plain: Record<string, unknown>): Promise<string[]> =>
    (await validate(toDto(plain))).map((error) => error.property);

  const shownRisks = [{ permissionSlug: 'feedback:read', riskLevel: 'Medium' }];
  const body = { stagingId: 'staging-a', shownRisks };

  it('accepts a staging id and the risks shown, with or without the confirmation set (#357, #1336)', async () => {
    await expect(invalidProperties(body)).resolves.toEqual([]);
    await expect(invalidProperties({ ...body, confirmCriticalSlugs: ['user:impersonate'] })).resolves.toEqual([]);
  });

  it('takes an optional locale, a string of at most 35 characters (#1301)', async () => {
    await expect(invalidProperties({ ...body, locale: 'de' })).resolves.toEqual([]);
    await expect(invalidProperties({ ...body, locale: 'x'.repeat(36) })).resolves.toEqual(['locale']);
  });

  it("requires the risks the read showed: approving grants at today's risk (#1336)", async () => {
    await expect(invalidProperties({ stagingId: 'staging-a' })).resolves.toEqual(['shownRisks']);
  });

  it('refuses a risk named twice for one permission, or a risk level that does not exist (#1336)', async () => {
    await expect(
      invalidProperties({
        ...body,
        shownRisks: [...shownRisks, { permissionSlug: 'feedback:read', riskLevel: 'High' }],
      }),
    ).resolves.toEqual(['shownRisks']);
    await expect(
      invalidProperties({ ...body, shownRisks: [{ permissionSlug: 'feedback:read', riskLevel: 'Severe' }] }),
    ).resolves.toEqual(['shownRisks']);
  });
});
