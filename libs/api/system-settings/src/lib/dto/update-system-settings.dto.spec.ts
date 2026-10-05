import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateSystemSettingsDto } from './update-system-settings.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function validateAsThePipeDoes(payload: PlainPayload) {
  const dto = plainToInstance(UpdateSystemSettingsDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return { dto, errors };
}

const keysFor = async (payload: PlainPayload) => validationCatalogKeys((await validateAsThePipeDoes(payload)).errors);

const NOT_NULLABLE = [
  'name',
  'allowPasswordResets',
  'allowUserRegistration',
  'allowUsernameChange',
  'feedbackReportRetentionDays',
  'feedbackReportServerRedactionEnabled',
  'requireContributionApproval',
  'contributionReclaimDays',
  'reviewGatewayLanguages',
];

const DAY_COUNTS = ['feedbackReportRetentionDays', 'contributionReclaimDays', 'auditLogRetentionDays'];

describe('UpdateSystemSettingsDto', () => {
  it('accepts an empty patch, since every setting is optional', async () => {
    expect(await keysFor({})).toEqual({});
  });

  it('accepts every setting in one patch', async () => {
    const payload: PlainPayload = {
      name: 'Game Night Server',
      allowPasswordResets: false,
      allowUserRegistration: false,
      allowUsernameChange: false,
      feedbackReportRetentionDays: 30,
      feedbackReportServerRedactionEnabled: false,
      requireContributionApproval: true,
      contributionReclaimDays: 7,
      auditLogRetentionDays: 365,
      reviewGatewayLanguages: true,
    };

    expect(await keysFor(payload)).toEqual({});
  });

  it('refuses feedbackRetentionDays, a name no column has (#571)', async () => {
    const { errors } = await validateAsThePipeDoes({ feedbackRetentionDays: 30 });

    expect(errors.map((error) => error.property)).toEqual(['feedbackRetentionDays']);
  });

  it('refuses null for every setting whose column is not nullable', async () => {
    // IsOptional would skip validation for null as well as for an omitted
    // property, and the write would then answer 500 on the column (#571).
    const { errors } = await validateAsThePipeDoes(
      Object.fromEntries(NOT_NULLABLE.map((property) => [property, null])),
    );

    expect(errors.map((error) => error.property).sort()).toEqual([...NOT_NULLABLE].sort());
  });

  it('names a catalog key for a null boolean', async () => {
    expect(await keysFor({ allowPasswordResets: null })).toEqual({
      'allowPasswordResets.isBoolean': 'validation.isBoolean',
    });
  });

  it('accepts null for the audit retention, where it means unlimited', async () => {
    expect(await keysFor({ auditLogRetentionDays: null })).toEqual({});
  });

  describe.each(DAY_COUNTS)('%s', (property) => {
    it.each([1, 36_500])('accepts %p', async (days) => {
      expect(await keysFor({ [property]: days })).toEqual({});
    });

    it.each([
      [0, 'min'],
      [36_501, 'max'],
      [1.5, 'isInt'],
    ])('refuses %p with %s', async (days, constraint) => {
      expect(await keysFor({ [property]: days })).toEqual({
        [`${property}.${constraint}`]: `validation.${constraint}`,
      });
    });
  });

  describe('name', () => {
    it('is trimmed before its length is measured', async () => {
      const { dto, errors } = await validateAsThePipeDoes({ name: `  ${'a'.repeat(100)}  ` });

      expect(errors).toEqual([]);
      expect(dto.name).toBe('a'.repeat(100));
    });

    it('refuses a name of only spaces', async () => {
      expect(await keysFor({ name: '   ' })).toEqual({ 'name.isNotEmpty': 'validation.isNotEmpty' });
    });

    it('refuses a name longer than 100 characters', async () => {
      expect(await keysFor({ name: 'a'.repeat(101) })).toEqual({ 'name.maxLength': 'validation.maxLength' });
    });
  });
});
