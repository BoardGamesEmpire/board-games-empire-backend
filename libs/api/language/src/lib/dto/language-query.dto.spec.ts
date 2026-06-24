import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { LanguageQueryDto } from './language-query.dto';

describe('LanguageQueryDto', () => {
  // Mirror the GLOBAL ValidationPipe transformOptions from apps/api/src/main.ts.
  // enableImplicitConversion is what breaks naive boolean transforms, so the
  // tests must run with it on to be meaningful.
  const toDto = (plain: Record<string, unknown>): LanguageQueryDto =>
    plainToInstance(LanguageQueryDto, plain, { enableImplicitConversion: true });

  describe('systemSupported', () => {
    it('stays undefined when the param is absent', async () => {
      const dto = toDto({});
      expect(dto.systemSupported).toBeUndefined();
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'systemSupported')).toHaveLength(0);
    });

    it('stays undefined (not false) when the value is explicitly undefined', () => {
      const dto = toDto({ systemSupported: undefined });
      expect(dto.systemSupported).toBeUndefined();
    });

    it("transforms the string 'true' into true", async () => {
      const dto = toDto({ systemSupported: 'true' });
      expect(dto.systemSupported).toBe(true);
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'systemSupported')).toHaveLength(0);
    });

    it("transforms the string 'false' into false", async () => {
      const dto = toDto({ systemSupported: 'false' });
      expect(dto.systemSupported).toBe(false);
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'systemSupported')).toHaveLength(0);
    });

    it("treats 'true' case-insensitively", () => {
      expect(toDto({ systemSupported: 'TRUE' }).systemSupported).toBe(true);
      expect(toDto({ systemSupported: 'True' }).systemSupported).toBe(true);
    });

    it("treats any non-'true' string as false", () => {
      expect(toDto({ systemSupported: 'yes' }).systemSupported).toBe(false);
      expect(toDto({ systemSupported: '1' }).systemSupported).toBe(false);
      expect(toDto({ systemSupported: '' }).systemSupported).toBe(false);
    });

    it('passes a real boolean through', () => {
      expect(toDto({ systemSupported: true }).systemSupported).toBe(true);
      expect(toDto({ systemSupported: false }).systemSupported).toBe(false);
    });
  });

  describe('name', () => {
    it('is optional', async () => {
      const dto = toDto({});
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'name')).toHaveLength(0);
    });

    it('accepts a string', async () => {
      const dto = toDto({ name: 'eng' });
      expect(dto.name).toBe('eng');
      const errors = await validate(dto);
      expect(errors.filter((e) => e.property === 'name')).toHaveLength(0);
    });
  });
});
