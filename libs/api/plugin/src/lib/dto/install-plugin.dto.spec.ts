import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { InstallPluginDto } from './install-plugin.dto';

describe('InstallPluginDto', () => {
  // Mirrors the global pipe (apps/api/src/main.ts), which converts implicitly.
  const toDto = (plain: Record<string, unknown>): InstallPluginDto =>
    plainToInstance(InstallPluginDto, plain, { enableImplicitConversion: true });

  const invalidProperties = async (plain: Record<string, unknown>): Promise<string[]> =>
    (await validate(toDto(plain))).map((error) => error.property);

  const shownRisks = [{ permissionSlug: 'feedback:read', riskLevel: 'Medium' }];
  const body = { sha256: 'a'.repeat(64), shownRisks };

  it('accepts a checksum and the risks the artifact read showed (#1336)', async () => {
    await expect(invalidProperties(body)).resolves.toEqual([]);
  });

  it("requires the risks the read showed: installing grants at today's risk (#1336)", async () => {
    await expect(invalidProperties({ sha256: body.sha256 })).resolves.toEqual(['shownRisks']);
  });

  it('refuses a risk named twice for one permission, or one with no slug (#1336)', async () => {
    await expect(
      invalidProperties({
        ...body,
        shownRisks: [...shownRisks, { permissionSlug: 'feedback:read', riskLevel: 'Low' }],
      }),
    ).resolves.toEqual(['shownRisks']);
    await expect(invalidProperties({ ...body, shownRisks: [{ riskLevel: 'Low' }] })).resolves.toEqual(['shownRisks']);
  });
});
