import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH } from './post-plugin-artifact.dto';
import { StagePluginUpdateDto } from './stage-plugin-update.dto';

const SHA = 'a'.repeat(64);

describe('StagePluginUpdateDto', () => {
  // Mirrors the global pipe (apps/api/src/main.ts), which converts implicitly.
  const toDto = (plain: Record<string, unknown>): StagePluginUpdateDto =>
    plainToInstance(StagePluginUpdateDto, plain, { enableImplicitConversion: true });

  const invalidProperties = async (plain: Record<string, unknown>): Promise<string[]> =>
    (await validate(toDto(plain))).map((error) => error.property);

  it('accepts a checksum, with or without the acknowledgement and the deep scan (#1096)', async () => {
    await expect(invalidProperties({ sha256: SHA })).resolves.toEqual([]);
    await expect(
      invalidProperties({ sha256: SHA, acknowledgeForbiddenImports: ['axios'], deepScan: true }),
    ).resolves.toEqual([]);
  });

  it('refuses a missing or empty checksum (#1096)', async () => {
    await expect(invalidProperties({})).resolves.toEqual(['sha256']);
    await expect(invalidProperties({ sha256: '' })).resolves.toEqual(['sha256']);
  });

  it('refuses a checksum past the length an install accepts (#1096)', async () => {
    await expect(
      invalidProperties({ sha256: 'a'.repeat(PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH + 1) }),
    ).resolves.toEqual(['sha256']);
    await expect(invalidProperties({ sha256: 'a'.repeat(PLUGIN_ARTIFACT_SHA256_INPUT_MAX_LENGTH) })).resolves.toEqual(
      [],
    );
  });

  it('refuses an acknowledgement that is not a list of strings (#1096)', async () => {
    await expect(invalidProperties({ sha256: SHA, acknowledgeForbiddenImports: 'axios' })).resolves.toEqual([
      'acknowledgeForbiddenImports',
    ]);
    await expect(invalidProperties({ sha256: SHA, acknowledgeForbiddenImports: [{}] })).resolves.toEqual([
      'acknowledgeForbiddenImports',
    ]);
  });

  // As on the install body: implicit conversion would turn a form-encoded
  // 'false' into true.
  it("reads a form-encoded 'false' as false, not true (#1096)", async () => {
    const dto = toDto({ sha256: SHA, deepScan: 'false' });

    expect(dto.deepScan).toBe(false);
    await expect(validate(dto)).resolves.toEqual([]);
  });
});
