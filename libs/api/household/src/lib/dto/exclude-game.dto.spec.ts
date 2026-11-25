import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { EXCLUDED_GAME_MAX_REASON_LENGTH } from '../constants/household.constants';
import { ExcludeGameDto } from './exclude-game.dto';

type PlainPayload = Record<string, unknown>;

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
const toDto = (payload: PlainPayload) => plainToInstance(ExcludeGameDto, payload, { enableImplicitConversion: true });

async function propertiesWithErrors(payload: PlainPayload): Promise<string[]> {
  const errors = await validate(toDto(payload), { whitelist: true, forbidNonWhitelisted: true });

  return errors.map((error) => error.property);
}

describe('ExcludeGameDto names a collection entry and an optional reason (#170)', () => {
  it.each([
    ['an entry alone', { collectionEntryId: 'entry-1' }],
    ['an entry with a reason', { collectionEntryId: 'entry-1', reason: 'Too fragile to lend' }],
    [
      'a reason of the longest length',
      { collectionEntryId: 'entry-1', reason: 'r'.repeat(EXCLUDED_GAME_MAX_REASON_LENGTH) },
    ],
    ['a null reason', { collectionEntryId: 'entry-1', reason: null }],
  ])('accepts %s', async (_label, payload) => {
    await expect(propertiesWithErrors(payload)).resolves.toEqual([]);
  });

  it.each([
    ['a missing entry', {}, ['collectionEntryId']],
    ['an empty entry', { collectionEntryId: '' }, ['collectionEntryId']],
    [
      'an overlong reason',
      { collectionEntryId: 'entry-1', reason: 'r'.repeat(EXCLUDED_GAME_MAX_REASON_LENGTH + 1) },
      ['reason'],
    ],
    // Read as sent: implicit conversion would store the number as the text '42'.
    ['a reason that is not text', { collectionEntryId: 'entry-1', reason: 42 }, ['reason']],
  ])('refuses %s (#170)', async (_label, payload, properties) => {
    await expect(propertiesWithErrors(payload)).resolves.toEqual(properties);
  });

  it('trims the reason, so padding is never stored (#170)', () => {
    expect(toDto({ collectionEntryId: 'entry-1', reason: '  Too fragile  ' }).reason).toBe('Too fragile');
  });

  it('reads a reason of only spaces as no reason, stored as null (#170)', async () => {
    const payload = { collectionEntryId: 'entry-1', reason: '   ' };

    expect(toDto(payload).reason).toBeNull();
    await expect(propertiesWithErrors(payload)).resolves.toEqual([]);
  });
});
