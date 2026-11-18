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
 * #934. The cap applies before the Markdown is sanitized: the sanitizer keeps
 * longer Markdown as plain text, which would flatten the headings and lists a
 * screen reader moves by.
 */
describe('PutPrivacyPolicyDto', () => {
  it('accepts Markdown at the limit', async () => {
    expect(await keysFor({ markdown: 'a'.repeat(PRIVACY_POLICY_MAX_LENGTH) })).toEqual({});
  });

  it('refuses Markdown one character past the limit, with the maxLength message', async () => {
    expect(await keysFor({ markdown: 'a'.repeat(PRIVACY_POLICY_MAX_LENGTH + 1) })).toEqual({
      'markdown.maxLength': 'validation.maxLength',
    });
  });

  // The validator counts a character outside the Basic Multilingual Plane
  // once, though it is two UTF-16 code units, so this passes; the service
  // refuses it with PRIVACY_POLICY_TOO_LONG before it is sanitized.
  it('lets through Markdown within the limit in characters but past it in UTF-16 code units', async () => {
    const markdown = '\u{1F600}'.repeat(PRIVACY_POLICY_MAX_LENGTH / 2 + 1);

    expect(markdown.length).toBeGreaterThan(PRIVACY_POLICY_MAX_LENGTH);
    expect(await keysFor({ markdown })).toEqual({});
  });

  // A missing value fails every constraint on the field, maxLength included.
  it('refuses a body with no markdown', async () => {
    expect(await keysFor({})).toMatchObject({ 'markdown.isString': 'validation.isString' });
  });

  it('refuses any other field', async () => {
    expect(Object.keys(await keysFor({ markdown: '# Policy', language: 'de' }))).toEqual([
      'language.whitelistValidation',
    ]);
  });
});
