import { PluginGrantStatus, RiskLevel } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import {
  CONSENT_ACT_MAX_ANSWERS,
  ReviewConsentDto,
  SwitchOnHouseholdPluginDto,
  SwitchOnUserPluginDto,
  ToggleConsentDto,
} from './consent-act.dto';

const SHA = 'a'.repeat(64);
const ANSWER = { permissionSlug: 'plugin|sample|sync', status: PluginGrantStatus.Granted, riskLevel: RiskLevel.Low };

// Mirrors the global pipe (apps/api/src/main.ts), which converts implicitly.
const invalidProperties = async <T extends object>(
  Dto: new () => T,
  plain: Record<string, unknown>,
): Promise<string[]> =>
  (await validate(plainToInstance(Dto, plain, { enableImplicitConversion: true }))).map((error) => error.property);

describe('consent act bodies (#1150)', () => {
  it.each(['A'.repeat(64), 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64)])(
    'refuses a sha that is not 64 lowercase hex characters: %s',
    async (manifestSha256) => {
      await expect(invalidProperties(ReviewConsentDto, { manifestSha256, answers: [ANSWER] })).resolves.toEqual([
        'manifestSha256',
      ]);
    },
  );

  it('refuses an answer without a risk level', async () => {
    const withoutRisk = { permissionSlug: ANSWER.permissionSlug, status: ANSWER.status };

    await expect(invalidProperties(ToggleConsentDto, { manifestSha256: SHA, answer: withoutRisk })).resolves.toEqual([
      'answer',
    ]);
    await expect(invalidProperties(ReviewConsentDto, { manifestSha256: SHA, answers: [withoutRisk] })).resolves.toEqual(
      ['answers'],
    );
  });

  it('refuses an answer status other than Granted or Denied', async () => {
    await expect(
      invalidProperties(ToggleConsentDto, { manifestSha256: SHA, answer: { ...ANSWER, status: 'Pending' } }),
    ).resolves.toEqual(['answer']);
  });

  it('a household switch-on accepts an empty answers list', async () => {
    await expect(invalidProperties(SwitchOnHouseholdPluginDto, { manifestSha256: SHA, answers: [] })).resolves.toEqual(
      [],
    );
  });

  it('a switch-on requires the answers property itself', async () => {
    await expect(invalidProperties(SwitchOnUserPluginDto, { manifestSha256: SHA })).resolves.toEqual(['answers']);
  });

  it('a household switch-on refuses a config that is not an object', async () => {
    await expect(
      invalidProperties(SwitchOnHouseholdPluginDto, { manifestSha256: SHA, answers: [], config: null }),
    ).resolves.toEqual(['config']);
  });

  it('a review refuses an empty answers list', async () => {
    await expect(invalidProperties(ReviewConsentDto, { manifestSha256: SHA, answers: [] })).resolves.toEqual([
      'answers',
    ]);
  });

  it('refuses more answers than a manifest can request', async () => {
    const answers = Array.from({ length: CONSENT_ACT_MAX_ANSWERS + 1 }, (_, i) => ({
      ...ANSWER,
      permissionSlug: `plugin|sample|p${i}`,
    }));

    await expect(invalidProperties(SwitchOnUserPluginDto, { manifestSha256: SHA, answers })).resolves.toEqual([
      'answers',
    ]);
  });

  it('accepts a toggle with one answer', async () => {
    await expect(invalidProperties(ToggleConsentDto, { manifestSha256: SHA, answer: ANSWER })).resolves.toEqual([]);
  });
});
