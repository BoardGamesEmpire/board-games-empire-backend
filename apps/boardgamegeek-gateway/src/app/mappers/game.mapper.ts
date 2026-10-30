import { isTrue } from '@bge/env';
import * as proto from '@boardgamesempire/proto-gateway';
import { BggLinkType, BggNameType, BggThingType, DEFAULT_EDITION_KEY } from '../constants';
import type { BggLink, BggName, BggSearchItem, BggText, BggThing, BggVersion } from '../types';
import { decodeDescription, decodeText } from './decode-text';
import { toLanguageDataList } from './language.mapper';

/**
 * BGG `type` → proto ContentType. Video games and RPG items and issues fall
 * through to UNSPECIFIED.
 */
const BGG_CONTENT_TYPE_MAP: Readonly<Record<string, proto.ContentType>> = {
  [BggThingType.BoardGame]: proto.ContentType.CONTENT_TYPE_BASE_GAME,
  [BggThingType.BoardGameExpansion]: proto.ContentType.CONTENT_TYPE_EXPANSION,
  [BggThingType.BoardGameAccessory]: proto.ContentType.CONTENT_TYPE_ACCESSORY,
};

/**
 * The content types BGG things of `thingTypes` map to, each once. A type the
 * map doesn't name is left out, since coverage never lists UNSPECIFIED.
 */
export function toContentTypes(thingTypes: readonly BggThingType[]): proto.ContentType[] {
  return [...new Set(thingTypes.flatMap((type) => BGG_CONTENT_TYPE_MAP[type] ?? []))];
}

/**
 * The BGG thing types among `thingTypes` whose content type is one of
 * `contentTypes`: what a search narrowed to those content types asks BGG
 * for. A content type no BGG thing type maps to adds none.
 */
export function toThingTypes(
  contentTypes: readonly proto.ContentType[],
  thingTypes: readonly BggThingType[],
): BggThingType[] {
  return thingTypes.filter((type) => {
    const contentType = BGG_CONTENT_TYPE_MAP[type];
    return contentType !== undefined && contentTypes.includes(contentType);
  });
}

const COMPLEXITY_WEIGHT_SCALE = 1000;

/** BGG's one platform: every game it sends is on it, and its platform list names it alone (#718). */
export const TABLETOP_PLATFORM: proto.PlatformData = {
  externalId: 'bgg-tabletop',
  name: 'Tabletop',
  abbreviation: 'TT',
  platformType: proto.PlatformType.PLATFORM_TYPE_TABLETOP,
};

/**
 * Picks the primary display name from a thing's `names` array, falling
 * back to the first entry if no primary is flagged. The value is as BGG sent
 * it, still encoded (#716).
 */
export function selectPrimaryName(names: readonly BggName[] | undefined): BggText | undefined {
  if (!names?.length) {
    return undefined;
  }

  const primary = names.find((n) => n.type === BggNameType.Primary);
  return (primary ?? names[0]).value;
}

/**
 * A name as trimmed, decoded text, or undefined when it's blank or absent. A
 * name the client parsed as a number or a boolean, such as "2048", is kept as
 * text (#716).
 */
function normalizeTitle(value: BggText | undefined): string | undefined {
  const trimmed = decodeText(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Supports both common BGG client shapes:
 * - canonical `names: [{ type: 'primary', value: '...' }]`
 * - flattened `name: '...'` with optional `alternateNames: string[]`
 */
function selectThingTitle(thing: Pick<BggThing, 'names' | 'name' | 'alternateNames'>): string {
  const directName = normalizeTitle(thing.name);
  if (directName) {
    return directName;
  }

  const fromNames = normalizeTitle(selectPrimaryName(thing.names));
  if (fromNames) {
    return fromNames;
  }

  for (const alternateName of thing.alternateNames ?? []) {
    const normalized = normalizeTitle(alternateName);
    if (normalized) {
      return normalized;
    }
  }

  return '';
}

/**
 * BGG link `inbound` may surface as a boolean or the literal string
 * `'true'` depending on client-library JSON conversion. Delegates to the
 * shared {@link isTrue} coercion so this stays a single-purpose named
 * wrapper rather than a third copy of the literal-`'true'` logic.
 */
export function isInbound(value: boolean | string | undefined): boolean {
  return isTrue(value);
}

/**
 * Extracts the BGG ids of every outbound expansion link on a thing.
 * Inbound links are excluded.
 */
export function getOutboundExpansionIds(thing: Pick<BggThing, 'links'>): number[] {
  return (thing.links ?? [])
    .filter((link) => link.type === BggLinkType.BoardGameExpansion && !isInbound(link.inbound))
    .map((link) => link.id);
}

function toContentType(thing: Pick<BggThing, 'type'>): proto.ContentType {
  return BGG_CONTENT_TYPE_MAP[thing.type] ?? proto.ContentType.CONTENT_TYPE_UNSPECIFIED;
}

function toBaseGameExternalId(thing: Pick<BggThing, 'links'>): string | undefined {
  const inboundExpansion = (thing.links ?? []).find(
    (link) => link.type === BggLinkType.BoardGameExpansion && isInbound(link.inbound),
  );
  return inboundExpansion ? String(inboundExpansion.id) : undefined;
}

function toSourceUrl(thing: Pick<BggThing, 'id' | 'type'>): string {
  const segment = thing.type === BggThingType.BoardGameExpansion ? 'boardgameexpansion' : 'boardgame';
  return `https://boardgamegeek.com/${segment}/${thing.id}`;
}

function linksOfType(thing: Pick<BggThing, 'links'>, type: BggLinkType): BggLink[] {
  return (thing.links ?? []).filter((link) => link.type === type && !isInbound(link.inbound));
}

/** A designer, artist, publisher, mechanic, category or family link: BGG's id and its name. */
interface NamedLink {
  externalId: string;
  name: string;
}

/**
 * The outbound links of `type`, each with its name trimmed and decoded. A link
 * whose name is blank or absent is skipped: the server matches people by name
 * and vocabulary entries by slug, so nameless links would all merge into one
 * record named "" (#716).
 */
function namedLinksOfType(thing: Pick<BggThing, 'links'>, type: BggLinkType): NamedLink[] {
  return linksOfType(thing, type).flatMap((link) => {
    const name = normalizeTitle(link.value);
    return name ? [{ externalId: String(link.id), name }] : [];
  });
}

/**
 * Maps a BGG family link to proto FamilyData. BGG encodes a sub-classification
 * in the value's "<Type>: <name>" prefix; the prefix is parsed into familyType.
 * The name arrives decoded, so the split sees the text a person reads (#716).
 */
function toFamilyData({ externalId, name: value }: NamedLink): proto.FamilyData {
  const colonIndex = value.indexOf(':');
  const familyType = colonIndex > 0 ? value.slice(0, colonIndex).trim() : undefined;
  const name = colonIndex > 0 ? value.slice(colonIndex + 1).trim() : value;

  return {
    externalId,
    name,
    familyType,
  } satisfies proto.FamilyData;
}

/**
 * An image URL as BGG meant it: the parser leaves an `&amp;` in its query
 * encoded (#716). A blank one is left out.
 */
function decodeUrl(value: string | undefined): string | undefined {
  return decodeText(value).trim() || undefined;
}

/**
 * Coerces the BGG "0 means unknown" sentinel into undefined.
 */
function coerceYear(year: number | undefined): number | undefined {
  return typeof year === 'number' && year > 0 ? year : undefined;
}

/**
 * Coerces BGG's "0 means unknown" sentinel on a player count, play time,
 * minimum age or average rating into undefined (#869, #880).
 */
function coercePositive(value: number | undefined): number | undefined {
  return typeof value === 'number' && value > 0 ? value : undefined;
}

/**
 * Both ends of a range BGG sends, or neither when its minimum is above its
 * maximum (#869). BGG's data holds such pairs, and there's no telling which
 * end is wrong. Kept, a reversed play time fits filters the game can't, and
 * the api refuses one from any other writer. Swapping the ends is the other
 * reading, left for later.
 */
function orderedRange(min: number | undefined, max: number | undefined): [number | undefined, number | undefined] {
  return min !== undefined && max !== undefined && min > max ? [undefined, undefined] : [min, max];
}

/** A thing's player counts, each end unknown when BGG doesn't know it. */
function toPlayerCounts(thing: BggThing): Pick<proto.GameSearchData, 'minPlayers' | 'maxPlayers'> {
  const [minPlayers, maxPlayers] = orderedRange(coercePositive(thing.minplayers), coercePositive(thing.maxplayers));
  return { minPlayers, maxPlayers };
}

/**
 * A thing's play time in minutes. playingtime stands in for an end BGG
 * gives no minimum or maximum for.
 */
function toPlayTimes(thing: BggThing): Pick<proto.GameSearchData, 'minPlaytime' | 'maxPlaytime'> {
  const playingTime = coercePositive(thing.playingtime);
  const [minPlaytime, maxPlaytime] = orderedRange(
    coercePositive(thing.minplaytime) ?? playingTime,
    coercePositive(thing.maxplaytime) ?? playingTime,
  );
  return { minPlaytime, maxPlaytime };
}

/**
 * A game's publish year as BGG sends it, with its "0 means unknown" sentinel
 * unset. Unlike coerceYear it keeps negative years, which BGG uses for games
 * from before the common era (#719). Sent as 0, an undated game would read as
 * a year, fail every publish-year range, and be stored with it on import.
 */
export function toPublishYear(year: number | undefined): number | undefined {
  return year === 0 ? undefined : year;
}

function toReleaseDate(year: number | undefined): string | undefined {
  const valid = coerceYear(year);
  return valid !== undefined ? `${valid}-01-01` : undefined;
}

/**
 * Builds the synthetic Tabletop release used for search-context (and as
 * the fallback when no version data is available). Carries identity and
 * availability fields only — no edition data.
 */
function toSyntheticTabletopRelease(thing: Pick<BggThing, 'yearpublished'>): proto.GameReleaseData {
  return {
    externalId: DEFAULT_EDITION_KEY,
    platform: TABLETOP_PLATFORM,
    status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
    releaseDate: toReleaseDate(thing.yearpublished),
    localizations: [],
    languages: [],
  } satisfies proto.GameReleaseData;
}

/**
 * Maps a single BGG version to a release. Edition-level overrides are
 * intentionally not populated — BGG versions don't expose differing
 * gameplay parameters.
 *
 * @todo utilize locale to filter language links
 */
function toVersionRelease(version: BggVersion): proto.GameReleaseData {
  return {
    externalId: String(version.id),
    platform: TABLETOP_PLATFORM,
    status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
    editionName: normalizeTitle(version.name),
    releaseYear: coerceYear(version.yearpublished),
    releaseDate: toReleaseDate(version.yearpublished),
    // BGG versions are flat — no edition hierarchy.
    parentEditionExternalId: undefined,
    languages: toLanguageDataList(version.links),
    localizations: [],
  } satisfies proto.GameReleaseData;
}

/**
 * Builds the GameReleaseData[] payload for a thing. When BGG returns
 * version data, emits one release per version. Otherwise emits a single synthetic "default" release.
 */
function toReleases(thing: BggThing): proto.GameReleaseData[] {
  const versions = thing.versions ?? [];

  if (versions.length === 0) {
    return [toSyntheticTabletopRelease(thing)];
  }

  return versions.map(toVersionRelease).filter((r) => r);
}

/**
 * Maps a BGG search-result item to proto GameSearchData, filled in from its
 * thing when BGG answered for it.
 *
 * Search answers carry no thumbnail, rating, player counts or description.
 * `searchGames` asks for each item's thing and fills those in from it (#880).
 * The title, content type and year stay as search found them, since the page
 * was filtered and built on them. The source URL follows the content type,
 * and the release is dated by search's year, so a result carries one year.
 * The title is the name BGG matched, which can be an alternate one; a blank
 * one takes the thing's.
 *
 * Without a thing, the result is as lean as search: `availableReleases` stays
 * empty, since search items have no release data.
 */
export function searchItemToGameSearchData(item: BggSearchItem, thing?: BggThing): proto.GameSearchData {
  // Trimmed, and a blank name falls back to `names`, as a fetched thing's title does (#716).
  const title = normalizeTitle(item.name) ?? normalizeTitle(selectPrimaryName(item.names)) ?? '';

  const found = {
    externalId: String(item.id),
    title,
    contentType: BGG_CONTENT_TYPE_MAP[item.type] ?? proto.ContentType.CONTENT_TYPE_UNSPECIFIED,
    yearPublished: toPublishYear(item.yearpublished),
    sourceUrl: toSourceUrl({ id: item.id, type: item.type }),
    availablePlatforms: [TABLETOP_PLATFORM],
    availableReleases: [],
  } satisfies proto.GameSearchData;

  if (!thing) {
    return found;
  }

  const fromThing = thingToGameSearchData(thing);

  return {
    ...fromThing,
    title: found.title || fromThing.title,
    contentType: found.contentType,
    yearPublished: found.yearPublished,
    sourceUrl: found.sourceUrl,
    availableReleases: [toSyntheticTabletopRelease(item)],
  } satisfies proto.GameSearchData;
}

/**
 * Maps a fully-detailed BGG thing to lean GameSearchData: an expansion the
 * expansion lookup streams, or the details a search result is filled in from
 * (#880). Edition fields stay absent in search context — a synthetic
 * Tabletop release with identity and availability data only.
 */
export function thingToGameSearchData(thing: BggThing): proto.GameSearchData {
  const title = selectThingTitle(thing);

  return {
    externalId: String(thing.id),
    title,
    contentType: toContentType(thing),
    yearPublished: toPublishYear(thing.yearpublished),
    thumbnailUrl: decodeUrl(thing.thumbnail),
    sourceUrl: toSourceUrl(thing),
    averageRating: coercePositive(thing.statistics?.ratings?.average),
    ...toPlayerCounts(thing),
    ...toPlayTimes(thing),
    baseGameExternalId: toBaseGameExternalId(thing),
    summary: decodeDescription(thing.description),
    availablePlatforms: [TABLETOP_PLATFORM],
    availableReleases: [toSyntheticTabletopRelease(thing)],
  } satisfies proto.GameSearchData;
}

/**
 * Maps a fully-detailed BGG thing to the proto GameData consumed by the
 * import worker.
 *
 * BGG-specific notes:
 *  - `themes`, `ageRatings`, `dlc` are always empty.
 *  - `complexityWeight` is scaled by 1000 to fit the proto's int32 contract.
 *  - When BGG returns `versions` (thing endpoint called with versions=1),
 *    each becomes a GameReleaseData; otherwise a single synthetic "default"
 *    release is emitted.
 */
export function thingToGameData(thing: BggThing, locale?: string): proto.GameData {
  const title = selectThingTitle(thing);
  const ratings = thing.statistics?.ratings;

  const complexityWeight =
    typeof ratings?.averageweight === 'number'
      ? Math.round(ratings.averageweight * COMPLEXITY_WEIGHT_SCALE)
      : undefined;

  const designers: proto.PersonData[] = namedLinksOfType(thing, BggLinkType.BoardGameDesigner);
  const artists: proto.PersonData[] = namedLinksOfType(thing, BggLinkType.BoardGameArtist);
  const publishers: proto.PublisherData[] = namedLinksOfType(thing, BggLinkType.BoardGamePublisher);
  const mechanics: proto.MechanicData[] = namedLinksOfType(thing, BggLinkType.BoardGameMechanic);
  const categories: proto.CategoryData[] = namedLinksOfType(thing, BggLinkType.BoardGameCategory);
  const families = namedLinksOfType(thing, BggLinkType.BoardGameFamily).map(toFamilyData);

  return {
    externalId: String(thing.id),
    title,
    contentType: toContentType(thing),

    description: decodeDescription(thing.description),
    yearPublished: toPublishYear(thing.yearpublished),
    thumbnailUrl: decodeUrl(thing.thumbnail),
    imageUrl: decodeUrl(thing.image),
    sourceUrl: toSourceUrl(thing),

    designers,
    artists,
    publishers,
    mechanics,
    categories,
    families,

    averageRating: coercePositive(ratings?.average),
    bayesRating: ratings?.bayesaverage,
    ratingsCount: ratings?.usersrated,
    ...toPlayerCounts(thing),
    ...toPlayTimes(thing),
    minAge: coercePositive(thing.minage),
    complexityWeight,

    baseGameExternalId: toBaseGameExternalId(thing),

    platforms: [TABLETOP_PLATFORM],
    releases: toReleases(thing),

    themes: [],
    ageRatings: [],
    summary: undefined,

    metadataKeys: [],
    metadataValues: [],

    dlc: [],
  } satisfies proto.GameData;
}
