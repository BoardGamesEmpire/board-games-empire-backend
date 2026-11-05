import { decodeHTMLStrict, decodeXML } from 'entities';
import type { BggText } from '../types';

/**
 * A name or link value as text. BGG encodes these once (`Tzolk&#039;in`,
 * `Railways &amp; Robber Barons`), and the client's parser leaves them
 * encoded, so they're decoded here (#716). One pass only: a second would turn
 * a literal `&amp;` in a name into `&`. A value the parser made a number or a
 * boolean, such as a title of "2048", comes back as text. A value BGG didn't
 * send comes back empty, so nothing is ever named "undefined".
 */
export function decodeText(value: BggText | undefined): string {
  return value === undefined ? '' : decodeXML(String(value));
}

/**
 * A description as text. BGG encodes a description's HTML entities and then
 * encodes the result again (`cities&amp;mdash;think`), so it takes an XML pass
 * and then an HTML one (#716). The HTML pass is strict: a run with no `;`,
 * such as `&notit`, stays as it is rather than becoming `¬it`.
 */
export function decodeDescription(value: BggText | undefined): string | undefined {
  return value === undefined ? undefined : decodeHTMLStrict(decodeXML(String(value)));
}
