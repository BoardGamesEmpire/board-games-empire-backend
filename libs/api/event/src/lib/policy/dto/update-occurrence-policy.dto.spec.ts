import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateOccurrencePolicyDto } from './update-occurrence-policy.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function propertiesWithErrors(payload: PlainPayload): Promise<string[]> {
  const dto = plainToInstance(UpdateOccurrencePolicyDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe('UpdateOccurrencePolicyDto', () => {
  // Every column of a date's policy can be null, which means the event's (#796).
  it("accepts null on every nullable column, which hands the field back to the event's (#796)", async () => {
    await expect(
      propertiesWithErrors({
        restrictToGameCategories: null,
        maxAttendees: null,
        maxTotalParticipants: null,
        strictCapacity: null,
        requireHostApprovalToJoin: null,
        allowSpectators: null,
        gameAdditionMode: null,
        restrictToAttendeePool: null,
        fillerMaxPlayTime: null,
        voteThresholdType: null,
        voteThresholdValue: null,
        voteQuorumType: null,
        voteQuorumValue: null,
        voteEligibility: null,
        interestedWeight: null,
        votingWindowHours: null,
      }),
    ).resolves.toEqual([]);
  });

  it('accepts a value on each column (#796)', async () => {
    await expect(
      propertiesWithErrors({
        gameAdditionMode: 'HostOnly',
        maxAttendees: 4,
        strictCapacity: true,
        voteThresholdType: 'Supermajority',
        voteThresholdValue: 66,
      }),
    ).resolves.toEqual([]);
  });

  // The flags' columns can't be null: false is "no flag" (#796).
  it('refuses null on each "no restriction" flag, whose columns cannot be null (#796)', async () => {
    await expect(
      propertiesWithErrors({
        platformTypesUnrestricted: null,
        platformsUnrestricted: null,
        capacityUnrestricted: null,
      }),
    ).resolves.toEqual(['platformTypesUnrestricted', 'platformsUnrestricted', 'capacityUnrestricted']);
  });

  it('accepts each "no restriction" flag (#796)', async () => {
    await expect(
      propertiesWithErrors({
        platformTypesUnrestricted: true,
        platformsUnrestricted: false,
        capacityUnrestricted: true,
      }),
    ).resolves.toEqual([]);
  });

  // Implicit conversion would make the string "false" true, so a malformed
  // "false" would lift the date's restriction instead of being refused (#796).
  it('refuses a string where a boolean belongs, rather than reading "false" as true (#796)', async () => {
    const booleans = [
      'restrictToGameCategories',
      'platformTypesUnrestricted',
      'platformsUnrestricted',
      'strictCapacity',
      'capacityUnrestricted',
      'requireHostApprovalToJoin',
      'allowSpectators',
      'restrictToAttendeePool',
    ];

    await expect(propertiesWithErrors(Object.fromEntries(booleans.map((key) => [key, 'false'])))).resolves.toEqual(
      booleans,
    );
  });

  // An empty list is the event's, so there is nothing for null to mean (#1268).
  it("refuses null for each list, and accepts an empty one, which is the event's (#1268)", async () => {
    await expect(
      propertiesWithErrors({ allowedCategoryIds: null, allowedPlatformTypes: null, allowedPlatformIds: null }),
    ).resolves.toEqual(['allowedCategoryIds', 'allowedPlatformTypes', 'allowedPlatformIds']);
    await expect(
      propertiesWithErrors({ allowedCategoryIds: [], allowedPlatformTypes: ['Tabletop'], allowedPlatformIds: [] }),
    ).resolves.toEqual([]);
  });

  it('refuses a platform type or game addition mode that does not exist (#796)', async () => {
    await expect(propertiesWithErrors({ allowedPlatformTypes: ['Nope'], gameAdditionMode: 'Nope' })).resolves.toEqual([
      'allowedPlatformTypes',
      'gameAdditionMode',
    ]);
  });

  // A date's policy has no invite controls of its own (#796).
  it('refuses a field the date has no column for (#796)', async () => {
    await expect(propertiesWithErrors({ allowMemberInvites: false })).resolves.toEqual(['allowMemberInvites']);
  });
});
