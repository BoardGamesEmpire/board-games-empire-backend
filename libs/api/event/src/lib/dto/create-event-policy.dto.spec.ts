import { VoteQuorumType, VoteThresholdType } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateEventPolicyDto } from './create-event-policy.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function constraintsByProperty(payload: PlainPayload): Promise<Record<string, string[]>> {
  const dto = plainToInstance(CreateEventPolicyDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return Object.fromEntries(errors.map((error) => [error.property, Object.keys(error.constraints ?? {})]));
}

/** Types that ask for a threshold and quorum value, so both are validated. */
const WITH_VOTE_VALUES = {
  voteThresholdType: VoteThresholdType.FixedCount,
  voteThresholdValue: 1,
  voteQuorumType: VoteQuorumType.FixedCount,
  voteQuorumValue: 1,
};

describe('CreateEventPolicyDto', () => {
  // Each column is a 32-bit Int, so a larger number answers 400 naming the
  // field rather than failing the write as a 500 (#1444).
  it.each([
    'maxAttendees',
    'maxTotalParticipants',
    'fillerMaxPlayTime',
    'voteThresholdValue',
    'voteQuorumValue',
    'votingWindowHours',
  ])('refuses %s past the 32-bit column range (#1444)', async (field) => {
    await expect(constraintsByProperty({ ...WITH_VOTE_VALUES, [field]: 2 ** 31 })).resolves.toEqual({
      [field]: ['max'],
    });
    await expect(constraintsByProperty({ ...WITH_VOTE_VALUES, [field]: 2 ** 31 - 1 })).resolves.toEqual({});
  });
});
