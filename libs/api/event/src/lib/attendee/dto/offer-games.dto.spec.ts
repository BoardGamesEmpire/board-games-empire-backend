import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OFFER_GAMES_MAX_IDS, OfferGamesDto } from './offer-games.dto';

/** Mirrors the global I18nValidationPipe configuration (see apps/api main.ts). */
async function parse(payload: unknown) {
  const dto = plainToInstance(OfferGamesDto, payload, { enableImplicitConversion: true });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });

  return {
    dto,
    failed: errors.map((error) => error.property),
    constraints: errors.flatMap((error) => Object.keys(error.constraints ?? {})),
  };
}

/** `count` items, each with `expansions` expansions, every id distinct. */
const items = (count: number, expansions = 0) =>
  Array.from({ length: count }, (_, item) => ({
    collectionId: `col-${item}`,
    ...(expansions > 0
      ? { expansionCollectionIds: Array.from({ length: expansions }, (_, index) => `exp-${item}-${index}`) }
      : {}),
  }));

describe('OfferGamesDto (#1188)', () => {
  it('takes a game with its expansions', async () => {
    const { dto, failed } = await parse({
      items: [
        { collectionId: 'col-catan', expansionCollectionIds: ['col-seafarers', 'col-cities'] },
        { collectionId: 'col-azul' },
      ],
    });

    expect(failed).toEqual([]);
    expect(dto.items).toEqual([
      { collectionId: 'col-catan', expansionCollectionIds: ['col-seafarers', 'col-cities'] },
      { collectionId: 'col-azul' },
    ]);
  });

  // The cap bounds the work one request asks for, and an expansion is an id
  // judged and written like any other.
  it('counts expansions toward the 100 cap', async () => {
    expect(OFFER_GAMES_MAX_IDS).toBe(100);
    expect((await parse({ items: items(50, 1) })).failed).toEqual([]);
    expect((await parse({ items: items(100) })).failed).toEqual([]);

    const over = await parse({ items: items(51, 1) });
    expect(over.failed).toEqual(['items']);
    expect(over.constraints).toEqual(['offeredIdsWithinCap']);
  });

  // An id named twice would be judged twice, and its second answer would
  // contradict its first.
  it('refuses an id named twice, as an item and as an expansion', async () => {
    const asItemAndExpansion = await parse({
      items: [{ collectionId: 'col-catan', expansionCollectionIds: ['col-azul'] }, { collectionId: 'col-azul' }],
    });
    expect(asItemAndExpansion.failed).toEqual(['items']);
    expect(asItemAndExpansion.constraints).toEqual(['noRepeatedOfferedIds']);

    const twiceAsExpansion = await parse({
      items: [{ collectionId: 'col-catan', expansionCollectionIds: ['col-seafarers', 'col-seafarers'] }],
    });
    expect(twiceAsExpansion.constraints).toEqual(['noRepeatedOfferedIds']);

    const twiceAsItem = await parse({ items: [{ collectionId: 'col-catan' }, { collectionId: 'col-catan' }] });
    expect(twiceAsItem.constraints).toEqual(['noRepeatedOfferedIds']);
  });

  // Every valid item names an id, so more items than the cap is over it. An
  // item that fails is validated too, so a body of empty items would
  // otherwise answer one error per item, as many as the body cap holds.
  it('refuses more items than the cap with one error for the size, whatever the items hold', async () => {
    const empty = await parse({ items: Array.from({ length: 50_000 }, () => ({})) });
    const nested = (await validate(empty.dto, { whitelist: true, forbidNonWhitelisted: true }))[0]?.children ?? [];

    expect(empty.failed).toEqual(['items']);
    expect(empty.constraints).toContain('arrayMaxSize');
    expect(nested.length).toBeLessThanOrEqual(OFFER_GAMES_MAX_IDS + 1);

    const full = await parse({ items: items(OFFER_GAMES_MAX_IDS + 1) });
    expect(full.constraints).toEqual(expect.arrayContaining(['arrayMaxSize', 'offeredIdsWithinCap']));
  });

  it('refuses no items', async () => {
    expect((await parse({ items: [] })).failed).toEqual(['items']);
    expect((await parse({})).failed).toEqual(['items']);
  });

  it('refuses an item without a collection id, or with an unknown field', async () => {
    expect((await parse({ items: [{ expansionCollectionIds: ['col-1'] }] })).failed).toEqual(['items']);
    expect((await parse({ items: [{ collectionId: 'col-1', quantity: 2 }] })).failed).toEqual(['items']);
  });
});
