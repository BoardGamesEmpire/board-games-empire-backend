import { readFileSync } from 'fs';
import { join } from 'path';
import { parseThings } from '../client/bgg-xml';
import type { BggThing } from '../types';
import { thingToGameData, thingToGameSearchData } from './game.mapper';
import { ENTITY_RUN, stringsIn } from './testing/entity-runs';

function entityRunsIn(value: unknown): string[] {
  return stringsIn(value).filter((text) => ENTITY_RUN.test(text));
}

/**
 * A live `thing` response from 2026-10-22, trimmed to one game (Tzolk'in):
 * its polls and accessory links removed, and 2 of its 23 versions kept.
 */
const TZOLKIN_XML = readFileSync(join(__dirname, 'fixtures/thing-126163.xml'), 'utf8');

const NUMBER_LIKE_XML =
  '<?xml version="1.0" encoding="utf-8"?><items><item type="boardgame" id="1">' +
  '<name type="primary" sortindex="1" value="007" /><description>x</description>' +
  '<link type="boardgamepublisher" id="5" value="1830" /></item></items>';

const BOOLEAN_TITLE_XML =
  '<?xml version="1.0" encoding="utf-8"?><items><item type="boardgame" id="2">' +
  '<name type="primary" sortindex="1" value="true" /><description>x</description></item></items>';

describe('the game mapper on a live BGG response (#716)', () => {
  let thing: BggThing;

  beforeAll(() => {
    [thing] = parseThings(TZOLKIN_XML);
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

// The old client's parser turned these into a number or a boolean, and "007"
// came back as "7" (#716). The client now keeps BGG's text as sent (#863).
describe('the game mapper on text that looks like a number or a boolean (#863)', () => {
  it('keeps a title and a publisher as BGG sent them', () => {
    const [thing] = parseThings(NUMBER_LIKE_XML);

    const game = thingToGameData(thing);

    expect(game.title).toBe('007');
    expect(game.publishers).toEqual([{ externalId: '5', name: '1830' }]);
  });

  it('keeps a title of "true"', () => {
    const [thing] = parseThings(BOOLEAN_TITLE_XML);

    expect(thingToGameData(thing).title).toBe('true');
  });
});
