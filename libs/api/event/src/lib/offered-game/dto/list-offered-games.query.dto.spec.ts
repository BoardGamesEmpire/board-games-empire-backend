import { ContentType, PlatformType } from '@bge/database';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListOfferedGamesQueryDto } from './list-offered-games.query.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function parse(payload: Record<string, unknown>) {
  const dto = plainToInstance(ListOfferedGamesQueryDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return {
    dto,
    failed: errors.map((error) => error.property),
    constraints: errors.flatMap((error) => Object.keys(error.constraints ?? {})),
  };
}

describe('ListOfferedGamesQueryDto (#1187)', () => {
  it('splits comma-separated lists and refuses an empty one', async () => {
    const split = await parse({ platformTypes: 'Tabletop,PC', excludeMediums: ['Digital'] });

    expect(split.failed).toEqual([]);
    expect(split.dto.platformTypes).toEqual([PlatformType.Tabletop, PlatformType.PC]);
    expect(split.dto.excludeMediums).toEqual(['Digital']);

    // `?attendeeIds=` reads as [], which would narrow to no one.
    const empty = await parse({ attendeeIds: '' });

    expect(empty.failed).toEqual(['attendeeIds']);
  });

  it('refuses a value outside each list', async () => {
    const { failed } = await parse({ excludePlatformTypes: 'Tabletop,Boardgame', contentTypes: 'Unknown' });

    // Unknown is a content type an offered game can have, unlike in a search.
    expect(failed).toEqual(['excludePlatformTypes']);
  });

  it('refuses a reversed range', async () => {
    const { failed, constraints } = await parse({ playerCountMin: '5', playerCountMax: '2' });

    expect(failed).toEqual(['playerCountMax']);
    expect(constraints).toEqual(['notLessThanProperty']);
  });

  it('reads a blank bound as absent', async () => {
    const { dto, failed } = await parse({ playTimeMax: '', publishYearMin: '  ' });

    expect(failed).toEqual([]);
    expect(dto.playTimeMax).toBeUndefined();
    expect(dto.publishYearMin).toBeUndefined();
  });

  it("reads include-unknown's 'false' as false", async () => {
    const { dto, failed } = await parse({ playTimeMin: '30', playTimeIncludeUnknown: 'false' });

    expect(failed).toEqual([]);
    expect(dto.playTimeMin).toBe(30);
    expect(dto.playTimeIncludeUnknown).toBe(false);
  });

  it('caps the attendee lists at 100', async () => {
    const ids = Array.from({ length: 101 }, (_, index) => `att-${index}`);

    const { failed } = await parse({ attendeeIds: ids.slice(0, 100), excludeAttendeeIds: ids.join(',') });

    expect(failed).toEqual(['excludeAttendeeIds']);
  });

  // Every list is capped, so a value repeated to the URL's length is refused
  // rather than carried into the read's `IN` list.
  it('caps each typed list at the number of values it can name', async () => {
    const platformTypes = Object.values(PlatformType);

    expect((await parse({ platformTypes: platformTypes.join(',') })).failed).toEqual([]);
    expect(
      (
        await parse({
          excludePlatformTypes: [...platformTypes, PlatformType.Tabletop].join(','),
          mediums: 'Physical,Digital,Physical',
          excludeMediums: 'Digital,Digital,Digital',
          contentTypes: Array(Object.values(ContentType).length + 1).fill('BaseGame'),
        })
      ).failed,
    ).toEqual(['excludePlatformTypes', 'mediums', 'excludeMediums', 'contentTypes']);
  });

  it('caps the title query at 200 characters', async () => {
    expect((await parse({ q: 'a'.repeat(200) })).failed).toEqual([]);
    expect((await parse({ q: 'a'.repeat(201) })).failed).toEqual(['q']);
  });

  it('keeps the page contract it extends', async () => {
    const { dto, failed } = await parse({ page: '2', limit: '5', q: 'catan' });

    expect(failed).toEqual([]);
    expect(dto.skip).toBe(5);
  });
});
