import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSearch, parseThings } from './bgg-xml';

/**
 * A live `thing` answer from 2026-10-22, trimmed to one game (Tzolk'in): its
 * polls and accessory links removed, and 2 of its 23 versions kept.
 */
const TZOLKIN_XML = readFileSync(join(__dirname, '../mappers/fixtures/thing-126163.xml'), 'utf8');

const thingXml = (inner: string) =>
  `<?xml version="1.0" encoding="utf-8"?><items termsofuse="https://boardgamegeek.com/xmlapi/termsofuse">` +
  `<item type="boardgame" id="1">${inner}</item></items>`;

describe('parseThings', () => {
  describe("Tzolk'in's answer", () => {
    const [thing] = parseThings(TZOLKIN_XML);

    it('reads the thing, and each name with its type', () => {
      expect(thing.id).toBe(126163);
      expect(thing.type).toBe('boardgame');
      expect(thing.names?.[0]).toEqual({ type: 'primary', sortindex: 1, value: 'Tzolk&#039;in: The Mayan Calendar' });
      expect(thing.names?.slice(1).every((name) => name.type === 'alternate')).toBe(true);
      expect(thing.yearpublished).toBe(2012);
    });

    // The mappers decode it, once for names and twice for descriptions. A
    // parser that decoded too would make that three times (#716).
    it('leaves the description exactly as BGG encoded it', () => {
      const sent = /<description>([\s\S]*?)<\/description>/.exec(TZOLKIN_XML)?.[1].trim();

      expect(thing.description).toBe(sent);
      expect(thing.description).toContain('&amp;');
    });

    it('reads its ratings as numbers', () => {
      expect(thing.statistics?.ratings?.averageweight).toBe(3.6623);
      expect(typeof thing.statistics?.ratings?.average).toBe('number');
    });

    it('reads its links, and its versions with their own links', () => {
      expect(thing.links).toContainEqual(expect.objectContaining({ type: 'boardgameexpansion', id: 134380 }));
      expect(thing.versions).toHaveLength(2);
      expect(thing.versions?.[0].links.length).toBeGreaterThan(0);
    });
  });

  // BGG's text arrives as BGG sent it. The old client's parser turned text
  // that looked like a number or a boolean into one, and back again lost
  // "007" and "1e3", and dropped an alternate name of "0" (#863).
  describe('text that looks like a number or a boolean (#863)', () => {
    const [thing] = parseThings(
      thingXml(
        '<name type="primary" sortindex="1" value="007"/>' +
          '<name type="alternate" sortindex="1" value="1e3"/>' +
          '<name type="alternate" sortindex="1" value="2.0"/>' +
          '<name type="alternate" sortindex="1" value="true"/>' +
          '<name type="alternate" sortindex="1" value="0"/>' +
          '<link type="boardgamepublisher" id="5" value="1830"/>',
      ),
    );

    it('keeps a name as BGG sent it', () => {
      expect(thing.names?.map((name) => name.value)).toEqual(['007', '1e3', '2.0', 'true', '0']);
    });

    it('keeps a link value as BGG sent it', () => {
      expect(thing.links).toEqual([{ type: 'boardgamepublisher', id: 5, value: '1830', inbound: undefined }]);
    });
  });

  // BGG's order is the only thing that puts the primary name first; the
  // type says which it is (#1082).
  it('keeps the type of a primary name that comes after an alternate one', () => {
    const [thing] = parseThings(
      thingXml(
        '<name type="alternate" sortindex="1" value="Tikal (DE)"/><name type="primary" sortindex="1" value="Tikal"/>',
      ),
    );

    expect(thing.names).toEqual([
      { type: 'alternate', sortindex: 1, value: 'Tikal (DE)' },
      { type: 'primary', sortindex: 1, value: 'Tikal' },
    ]);
  });

  it('names a version by its primary name, wherever BGG puts it', () => {
    const [thing] = parseThings(
      thingXml(
        '<versions><item type="boardgameversion" id="9">' +
          '<name type="alternate" value="Second"/><name type="primary" value="First edition"/>' +
          '</item></versions>',
      ),
    );

    expect(thing.versions?.[0].name).toBe('First edition');
  });

  it('reads an answer with no thing as none', () => {
    expect(parseThings('<?xml version="1.0" encoding="utf-8"?><items termsofuse=""></items>')).toEqual([]);
    expect(parseThings('<items></items>')).toEqual([]);
  });

  // A proxy or a challenge page can answer 200 in BGG's place. It is a
  // failure, never BGG finding nothing (#1082).
  it.each([
    [
      'an HTML page',
      '<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><p>Checking</p></body></html>',
    ],
    ['an empty body', ''],
    [
      'another XML document',
      '<?xml version="1.0"?><errors><error><message>Rate limit exceeded</message></error></errors>',
    ],
  ])('refuses %s', (_kind, body) => {
    expect(() => parseThings(body)).toThrow('BGG answered without an <items> document');
  });
});

describe('parseSearch', () => {
  it('reads each item with its name and its year', () => {
    const result = parseSearch(
      '<?xml version="1.0" encoding="utf-8"?><items total="2" termsofuse="">' +
        '<item type="boardgame" id="126163"><name type="primary" value="Tzolk&#039;in: The Mayan Calendar"/>' +
        '<yearpublished value="2012" /></item>' +
        '<item type="boardgameexpansion" id="143065"><name type="primary" value="2048"/></item>' +
        '</items>',
    );

    expect(result).toEqual({
      total: 2,
      items: [
        { id: 126163, type: 'boardgame', name: 'Tzolk&#039;in: The Mayan Calendar', yearpublished: 2012 },
        { id: 143065, type: 'boardgameexpansion', name: '2048', yearpublished: undefined },
      ],
    });
  });

  it('refuses an answer that is not an <items> document (#1082)', () => {
    expect(() => parseSearch('<html><body>Service unavailable</body></html>')).toThrow(
      'BGG answered without an <items> document',
    );
  });

  it('reads an answer with no item as no items', () => {
    expect(parseSearch('<?xml version="1.0" encoding="utf-8"?><items total="0" termsofuse=""></items>')).toEqual({
      total: 0,
      items: undefined,
    });
  });
});
