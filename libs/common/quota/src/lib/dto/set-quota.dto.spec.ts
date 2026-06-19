import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { SetQuotaDto } from './set-quota.dto';

/** Property names that produced at least one validation error for `input`. */
function invalidProps(input: Record<string, unknown>): string[] {
  return validateSync(plainToInstance(SetQuotaDto, input)).map((error) => error.property);
}

describe('SetQuotaDto', () => {
  it('accepts a fully specified valid body', () => {
    expect(invalidProps({ limit: '1024', softOverage: true, enforced: false, description: 'café' })).toEqual([]);
  });

  it('accepts an empty body — every field is optional on update', () => {
    expect(invalidProps({})).toEqual([]);
  });

  describe('limit', () => {
    it.each(['0', '5368709120'])('accepts the non-negative integer string %p', (limit) => {
      expect(invalidProps({ limit })).toEqual([]);
    });

    it.each(['-1', '1.5', 'ten', '0x10', ''])('rejects %p', (limit) => {
      expect(invalidProps({ limit })).toContain('limit');
    });
  });

  describe.each(['softOverage', 'enforced'] as const)('%s', (prop) => {
    it.each([true, false])('accepts the boolean %p', (value) => {
      expect(invalidProps({ [prop]: value })).toEqual([]);
    });

    it('is skipped when omitted', () => {
      expect(invalidProps({})).not.toContain(prop);
    });

    it('rejects null (the @IsOptional null-bypass that wrote null to a non-nullable column)', () => {
      expect(invalidProps({ [prop]: null })).toContain(prop);
    });

    it('rejects a non-boolean', () => {
      expect(invalidProps({ [prop]: 'yes' })).toContain(prop);
    });
  });

  describe('description', () => {
    it('rejects a string longer than 280 chars', () => {
      expect(invalidProps({ description: 'x'.repeat(281) })).toContain('description');
    });
  });
});
