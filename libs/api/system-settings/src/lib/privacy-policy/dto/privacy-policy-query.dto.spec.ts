import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PRIVACY_POLICY_LANG_MAX_LENGTH, PrivacyPolicyQueryDto } from './privacy-policy-query.dto';

/**
 * #934. The global validation pipe refuses a query parameter no validator
 * names, so `lang` must carry one to be accepted at all.
 */
describe('PrivacyPolicyQueryDto', () => {
  const failingFields = async (plain: Record<string, unknown>): Promise<string[]> => {
    const errors = await validate(plainToInstance(PrivacyPolicyQueryDto, plain), {
      forbidNonWhitelisted: true,
      whitelist: true,
    });

    return errors.map((error) => error.property);
  };

  it('accepts no lang, and a lang at its limit', async () => {
    expect(await failingFields({})).toEqual([]);
    expect(await failingFields({ lang: 'a'.repeat(PRIVACY_POLICY_LANG_MAX_LENGTH) })).toEqual([]);
  });

  // Nonsense that fits is matched against nothing and falls back to English.
  it('accepts a lang that is not a language tag', async () => {
    expect(await failingFields({ lang: '@@' })).toEqual([]);
  });

  it('refuses a lang one character past the limit', async () => {
    expect(await failingFields({ lang: 'a'.repeat(PRIVACY_POLICY_LANG_MAX_LENGTH + 1) })).toEqual(['lang']);
  });

  it('refuses any other query parameter', async () => {
    expect(await failingFields({ language: 'de' })).toEqual(['language']);
  });
});
