import { validationCatalogKeys } from '@bge/testing';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PRIVACY_POLICY_MAX_LENGTH } from '../privacy-policy.constants';
import { PutPrivacyPolicyDto } from './put-privacy-policy.dto';

/** Validates `plain` as the global validation pipe does (apps/api main.ts): the catalog key of each failure. */
const keysFor = async (plain: Record<string, unknown>) =>
  validationCatalogKeys(
    await validate(plainToInstance(PutPrivacyPolicyDto, plain, { enableImplicitConversion: true }), {
      forbidNonWhitelisted: true,
      whitelist: true,
    }),
  );

/**
 * #934. The length is not the request validation's to check: class-validator
 * counts code points, the limit counts UTF-16 code units, and one rule would be
 * refused in two shapes. The service refuses it, with PRIVACY_POLICY_TOO_LONG.
 */
describe('PutPrivacyPolicyDto', () => {
  it('leaves the length to the service, whether past the limit in code points or in UTF-16 code units', async () => {
    const pastInCodePoints = 'a'.repeat(PRIVACY_POLICY_MAX_LENGTH + 1);
    const pastInCodeUnits = '\u{1F600}'.repeat(PRIVACY_POLICY_MAX_LENGTH / 2 + 1);

    expect(await keysFor({ markdown: pastInCodePoints })).toEqual({});
    expect(await keysFor({ markdown: pastInCodeUnits })).toEqual({});
  });

  it('refuses a body with no markdown', async () => {
    expect(await keysFor({})).toMatchObject({ 'markdown.isString': 'validation.isString' });
  });

  it('refuses any other field', async () => {
    expect(Object.keys(await keysFor({ markdown: '# Policy', language: 'de' }))).toEqual([
      'language.whitelistValidation',
    ]);
  });
});
