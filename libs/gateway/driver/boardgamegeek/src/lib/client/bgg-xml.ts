import { XMLParser } from 'fast-xml-parser';
import { BggNameType } from '../constants';
import type { BggLink, BggName, BggRatings, BggSearchItem, BggSearchResult, BggThing, BggVersion } from '../types';

/** An element as the parser hands it over: attributes under `@_`, children by tag. */
type XmlElement = Record<string, unknown>;

/** The elements BGG may repeat, kept as arrays even when one arrives. */
const REPEATED = new Set(['item', 'name', 'link', 'version']);

/**
 * Reads BGG's XML and keeps its text as BGG sent it (#863): no value is
 * turned into a number or a boolean, so "007" stays "007", and no entity is
 * decoded, which the mappers do once for names and twice for descriptions
 * (#716). Leaving entities alone also means a DOCTYPE can't expand any.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  trimValues: true,
  isArray: (tagName, _jPath, _isLeafNode, isAttribute) => !isAttribute && REPEATED.has(tagName),
});

const asElement = (node: unknown): XmlElement | undefined =>
  typeof node === 'object' && node !== null && !Array.isArray(node) ? (node as XmlElement) : undefined;

const elements = (node: unknown): XmlElement[] =>
  Array.isArray(node) ? node.map(asElement).filter((each): each is XmlElement => each !== undefined) : [];

const attribute = (element: XmlElement | undefined, name: string): string | undefined => {
  const value = element?.[`@_${name}`];
  return typeof value === 'string' ? value : undefined;
};

const toNumber = (value: string | undefined): number | undefined => (value === undefined ? undefined : Number(value));

/** A child that carries its value in an attribute, such as `<yearpublished value="2012"/>`. */
const valueOf = (parent: XmlElement, tag: string): string | undefined => {
  const child = parent[tag];
  return attribute(asElement(Array.isArray(child) ? child[0] : child), 'value');
};

/** A child's text, such as `<thumbnail>https://…</thumbnail>`. */
const textOf = (parent: XmlElement, tag: string): string | undefined => {
  const child = parent[tag];

  if (typeof child === 'string') {
    return child;
  }

  const text = asElement(child)?.['#text'];
  return typeof text === 'string' ? text : undefined;
};

/** Every name with its type, in the order BGG sent them, or none when there's no `<name>`. */
const namesOf = (item: XmlElement): BggName[] | undefined =>
  item['name'] === undefined
    ? undefined
    : elements(item['name']).flatMap((name) => {
        const value = attribute(name, 'value');
        return value === undefined
          ? []
          : [{ type: attribute(name, 'type') ?? '', sortindex: toNumber(attribute(name, 'sortindex')), value }];
      });

/** The name BGG marks primary, or the first one when none is marked. */
const primaryNameOf = (item: XmlElement): string | undefined => {
  const names = namesOf(item);
  return (names?.find((name) => name.type === BggNameType.Primary) ?? names?.[0])?.value;
};

const toLink = (link: XmlElement): BggLink => ({
  type: attribute(link, 'type') ?? '',
  id: Number(attribute(link, 'id')),
  value: attribute(link, 'value'),
  inbound: attribute(link, 'inbound'),
});

const linksOf = (item: XmlElement): BggLink[] | undefined =>
  item['link'] === undefined ? undefined : elements(item['link']).map(toLink);

const toRatings = (ratings: XmlElement): BggRatings => ({
  average: toNumber(valueOf(ratings, 'average')),
  bayesaverage: toNumber(valueOf(ratings, 'bayesaverage')),
  usersrated: toNumber(valueOf(ratings, 'usersrated')),
  averageweight: toNumber(valueOf(ratings, 'averageweight')),
  numweights: toNumber(valueOf(ratings, 'numweights')),
});

const toVersion = (version: XmlElement): BggVersion => ({
  type: attribute(version, 'type') ?? '',
  id: Number(attribute(version, 'id')),
  links: linksOf(version) ?? [],
  name: primaryNameOf(version) ?? '',
  yearpublished: Number(valueOf(version, 'yearpublished')),
  productcode: valueOf(version, 'productcode') ?? '',
  width: Number(valueOf(version, 'width')),
  length: Number(valueOf(version, 'length')),
  depth: Number(valueOf(version, 'depth')),
  weight: Number(valueOf(version, 'weight')),
});

const toThing = (item: XmlElement): BggThing => {
  const statistics = asElement(item['statistics']);
  const ratings = statistics && asElement(statistics['ratings']);
  const versions = asElement(item['versions'])?.['item'];

  return {
    id: Number(attribute(item, 'id')),
    type: attribute(item, 'type') ?? '',
    thumbnail: textOf(item, 'thumbnail'),
    image: textOf(item, 'image'),
    description: textOf(item, 'description'),
    yearpublished: toNumber(valueOf(item, 'yearpublished')),
    minplayers: toNumber(valueOf(item, 'minplayers')),
    maxplayers: toNumber(valueOf(item, 'maxplayers')),
    playingtime: toNumber(valueOf(item, 'playingtime')),
    minplaytime: toNumber(valueOf(item, 'minplaytime')),
    maxplaytime: toNumber(valueOf(item, 'maxplaytime')),
    minage: toNumber(valueOf(item, 'minage')),
    names: namesOf(item),
    links: linksOf(item),
    statistics: statistics && { ratings: ratings && toRatings(ratings) },
    versions: versions === undefined ? undefined : elements(versions).map(toVersion),
  };
};

const toSearchItem = (item: XmlElement): BggSearchItem => ({
  id: Number(attribute(item, 'id')),
  type: attribute(item, 'type') ?? '',
  name: primaryNameOf(item),
  yearpublished: toNumber(valueOf(item, 'yearpublished')),
});

/**
 * The `<items>` element of a BGG answer. An answer without one, such as a
 * proxy's or a challenge's HTML page sent as 200, fails, so it never reads as
 * BGG finding nothing (#1082). An `<items>` with no attributes or children
 * parses as empty text, and is an empty element.
 */
const itemsOf = (xml: string): XmlElement => {
  const document = asElement(parser.parse(xml));
  const items = document?.['items'];

  if (items === '') {
    return {};
  }

  const element = asElement(items);

  if (element === undefined) {
    throw new Error('BGG answered without an <items> document');
  }

  return element;
};

/**
 * The things in a `/thing` answer. The fields mean what `bgg-ts-client`
 * 0.2.0's made them mean, except that text stays text (#863) and each name
 * keeps its type, so the mappers pick the primary one by its type (#1082).
 */
export function parseThings(xml: string): BggThing[] {
  return elements(itemsOf(xml)['item']).map(toThing);
}

/** A `/search` answer. `items` is absent when BGG matched nothing, as it was with `bgg-ts-client` (#967). */
export function parseSearch(xml: string): BggSearchResult {
  const items = itemsOf(xml);
  const found = items['item'];

  return {
    total: toNumber(attribute(items, 'total')) ?? 0,
    items: found === undefined ? undefined : elements(found).map(toSearchItem),
  };
}
