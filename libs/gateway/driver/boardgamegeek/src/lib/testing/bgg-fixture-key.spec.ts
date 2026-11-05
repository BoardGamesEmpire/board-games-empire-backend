import { bggFixtureKey } from './bgg-fixture-key';

/**
 * The old client and the new one build their URLs differently, so a
 * fixture's name comes from what the URL means, not how it's spelled
 * (#1082).
 */
describe('bggFixtureKey', () => {
  it('names a request by its endpoint and its parameters, sorted by name', () => {
    expect(
      bggFixtureKey(
        'https://boardgamegeek.com/xmlapi2/thing?id=126163&type=boardgame,boardgameexpansion&stats=1&versions=1',
      ),
    ).toBe('thing__id=126163__stats=1__type=boardgame,boardgameexpansion__versions=1');
  });

  it('gives an encoded parameter value the same key as the value as written', () => {
    expect(
      bggFixtureKey(
        new URL(
          'https://boardgamegeek.com/xmlapi2/thing?versions=1&stats=1&type=boardgame%2Cboardgameexpansion&id=126163',
        ),
      ),
    ).toBe('thing__id=126163__stats=1__type=boardgame,boardgameexpansion__versions=1');
  });

  it("replaces a character a file name can't safely hold", () => {
    expect(bggFixtureKey("https://boardgamegeek.com/xmlapi2/search?query=Tzolk'in&type=boardgame")).toBe(
      'search__query=Tzolk_in__type=boardgame',
    );
  });
});
