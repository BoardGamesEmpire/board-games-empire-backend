import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UninstallPluginDto } from './uninstall-plugin.dto';

describe('UninstallPluginDto', () => {
  // Mirrors the GLOBAL pipe (apps/api/src/main.ts): enableImplicitConversion
  // coerces with Boolean(), and Boolean('false') is true. The app registers
  // urlencoded body parsing app-wide, so a form-encoded uninstall arrives
  // with purgeData as a STRING — the exact shape that would otherwise invert
  // an opt-out into an irreversible delete of every unit's config.
  const toDto = (plain: Record<string, unknown>): UninstallPluginDto =>
    plainToInstance(UninstallPluginDto, plain, { enableImplicitConversion: true });

  it('is absent when omitted — the service owns the default', async () => {
    const dto = toDto({});

    expect(dto.purgeData).toBeUndefined();
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each([
    ['false', false],
    ['0', false],
    ['no', false],
    ['true', true],
    ['TRUE', true],
  ])('reads the string %p as %p', async (raw, expected) => {
    const dto = toDto({ purgeData: raw });

    expect(dto.purgeData).toBe(expected);
    await expect(validate(dto)).resolves.toHaveLength(0);
  });

  it.each([
    [true, true],
    [false, false],
  ])('passes a real %p through unchanged', async (raw, expected) => {
    const dto = toDto({ purgeData: raw });

    expect(dto.purgeData).toBe(expected);
    await expect(validate(dto)).resolves.toHaveLength(0);
  });
});
