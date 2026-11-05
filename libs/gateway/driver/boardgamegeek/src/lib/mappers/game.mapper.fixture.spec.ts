import { BggThingDtoParser } from 'bgg-ts-client/dist/cjs/dto/dtoparser/concrete/BggThingDtoParser.js';
import { XmlResponseParser } from 'bgg-ts-client/dist/cjs/responseparser/concrete/XmlResponseParser.js';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { BggThing } from '../types';
import { thingToGameData, thingToGameSearchData } from './game.mapper';
import { ENTITY_RUN, stringsIn } from './testing/entity-runs';

/**
 * Parses a `thing` response through the client's own parser, as BggClient
 * does. That parser leaves entities encoded, and turns a value that looks
 * like a number into a number (#716).
 */
async function parseThings(xml: string): Promise<BggThing[]> {
  const json = await new XmlResponseParser().parseResponse(xml);
  return (await new BggThingDtoParser().jsonToDto(json)) as unknown as BggThing[];
}

function entityRunsIn(value: unknown): string[] {
  return stringsIn(value).filter((text) => ENTITY_RUN.test(text));
}

/**
 * A live `thing` response from 2026-10-22, trimmed to one game (Tzolk'in):
 * its polls and accessory links removed, and 2 of its 23 versions kept.
 */
const TZOLKIN_XML = readFileSync(join(__dirname, 'fixtures/thing-126163.xml'), 'utf8');

const DIGITS_ONLY_XML =
  '<?xml version="1.0" encoding="utf-8"?><items><item type="boardgame" id="1">' +
  '<name type="primary" sortindex="1" value="2048" /><description>x</description>' +
  '<link type="boardgamepublisher" id="5" value="1830" /></item></items>';

const BOOLEAN_TITLE_XML =
  '<?xml version="1.0" encoding="utf-8"?><items><item type="boardgame" id="2">' +
  '<name type="primary" sortindex="1" value="true" /><description>x</description></item></items>';

describe('the game mapper on a live BGG response (#716)', () => {
  let thing: BggThing;

  beforeAll(async () => {
    [thing] = await parseThings(TZOLKIN_XML);
  });

  it('leaves no entity in any string it maps from a live BGG response (#716)', () => {
    expect(entityRunsIn(thingToGameData(thing))).toEqual([]);
    expect(entityRunsIn(thingToGameSearchData(thing))).toEqual([]);
  });

  it('decodes the title', () => {
    expect(thingToGameData(thing).title).toBe(`Tzolk'in: The Mayan Calendar`);
  });

  it('decodes the description twice', () => {
    expect(thingToGameData(thing).description).toContain('to let the time work for you – but');
  });

  it('decodes a family’s name before splitting off its type', () => {
    const family = thingToGameData(thing).families.find((entry) => entry.externalId === '60542');

    expect(family).toEqual({ externalId: '60542', familyType: 'Game', name: `Tzolk'in – The Mayan Calendar` });
  });

  it('sends a description with no markup, so plain text stays its content format', () => {
    expect(thingToGameData(thing).description).not.toMatch(/<\/?[a-z][^>]*>/i);
  });
});

describe('the game mapper on values the client parses as numbers or booleans (#716)', () => {
  it('keeps a title made only of digits', async () => {
    const [thing] = await parseThings(DIGITS_ONLY_XML);

    const game = thingToGameData(thing);

    expect(game.title).toBe('2048');
    expect(game.publishers).toEqual([{ externalId: '5', name: '1830' }]);
  });

  it('keeps a title of "true", which the client parses as a boolean', async () => {
    const [thing] = await parseThings(BOOLEAN_TITLE_XML);

    expect(thingToGameData(thing).title).toBe('true');
  });
});
