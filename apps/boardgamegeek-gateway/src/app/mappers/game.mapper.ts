import * as proto from '@board-games-empire/proto-gateway';
import { BggLinkType, BggNameType, BggThingType, DEFAULT_EDITION_KEY } from '../constants';
import type { BggLink, BggName, BggSearchItem, BggThing, BggVersion } from '../types';
import { toLanguageDataList } from './language.mapper';

/**
 * BGG `type` → proto ContentType. Accessories fall through to UNSPECIFIED.
 */
const BGG_CONTENT_TYPE_MAP: Readonly<Record<string, proto.ContentType>> = {
  [BggThingType.BoardGame]: proto.ContentType.CONTENT_TYPE_BASE_GAME,
  [BggThingType.BoardGameExpansion]: proto.ContentType.CONTENT_TYPE_EXPANSION,
  [BggThingType.BoardGameAccessory]: proto.ContentType.CONTENT_TYPE_ACCESSORY,
};

const COMPLEXITY_WEIGHT_SCALE = 1000;

const TABLETOP_PLATFORM: proto.PlatformData = {
  externalId: 'bgg-tabletop',
  name: 'Tabletop',
  abbreviation: 'TT',
  platformType: proto.PlatformType.PLATFORM_TYPE_TABLETOP,
};

/**
 * Picks the primary display name from a thing's `names` array, falling
 * back to the first entry if no primary is flagged.
 */
export function selectPrimaryName(names: readonly BggName[] | undefined): string | undefined {
  if (!names?.length) {
    return undefined;
  }

  const primary = names.find((n) => n.type === BggNameType.Primary);
  return (primary ?? names[0]).value;
}

function normalizeTitle(value: string | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Supports both common BGG client shapes:
 * - canonical `names: [{ type: 'primary', value: '...' }]`
 * - flattened `name: '...'` with optional `alternateNames: string[]`
 */
function selectThingTitle(thing: Pick<BggThing, 'names'> & { name?: string; alternateNames?: string[] }): string {
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
 * `'true'` depending on client-library JSON conversion. Treat both as
 * truthy.
 */
export function isInbound(value: boolean | string | undefined): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return false;
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

function toPersonData(link: BggLink): proto.PersonData {
  return {
    externalId: String(link.id),
    name: link.value,
  } satisfies proto.PersonData;
}

function toPublisherData(link: BggLink): proto.PublisherData {
  return {
    externalId: String(link.id),
    name: link.value,
  } satisfies proto.PublisherData;
}

function toMechanicData(link: BggLink): proto.MechanicData {
  return {
    externalId: String(link.id),
    name: link.value,
  } satisfies proto.MechanicData;
}

function toCategoryData(link: BggLink): proto.CategoryData {
  return {
    externalId: String(link.id),
    name: link.value,
  } satisfies proto.CategoryData;
}

/**
 * Maps a BGG family link to proto FamilyData. BGG encodes a sub-classification
 * in the value's "<Type>: <name>" prefix; the prefix is parsed into familyType.
 */
function toFamilyData(link: BggLink): proto.FamilyData {
  const colonIndex = link.value.indexOf(':');
  const familyType = colonIndex > 0 ? link.value.slice(0, colonIndex).trim() : undefined;
  const name = colonIndex > 0 ? link.value.slice(colonIndex + 1).trim() : link.value;

  return {
    externalId: String(link.id),
    name,
    familyType,
  } satisfies proto.FamilyData;
}

/**
 * Coerces the BGG "0 means unknown" sentinel into undefined.
 */
function coerceYear(year: number | undefined): number | undefined {
  return typeof year === 'number' && year > 0 ? year : undefined;
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
    editionName: version.name || undefined,
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
 * Maps a BGG search-result item to the lean proto GameSearchData.
 *
 * Search responses do not carry thumbnails, ratings, player counts, or
 * description — those fields stay undefined here and are populated by
 * a follow-up FetchGame call. `availableReleases` is intentionally
 * empty: search items have no platform/release data.
 */
export function searchItemToGameSearchData(item: BggSearchItem): proto.GameSearchData {
  const title = item.name ?? selectPrimaryName(item.names) ?? '';

  return {
    externalId: String(item.id),
    title,
    contentType: BGG_CONTENT_TYPE_MAP[item.type] ?? proto.ContentType.CONTENT_TYPE_UNSPECIFIED,
    yearPublished: item.yearpublished,
    sourceUrl: toSourceUrl({ id: item.id, type: item.type }),
    availablePlatforms: [TABLETOP_PLATFORM],
    availableReleases: [],
  } satisfies proto.GameSearchData;
}

/**
 * Maps a fully-detailed BGG thing (used for expansion streaming) to lean
 * GameSearchData. Edition fields stay absent in search context — a
 * synthetic Tabletop release with identity and availability data only.
 */
export function thingToGameSearchData(thing: BggThing): proto.GameSearchData {
  const title = selectThingTitle(thing);

  return {
    externalId: String(thing.id),
    title,
    contentType: toContentType(thing),
    yearPublished: thing.yearpublished,
    thumbnailUrl: thing.thumbnail,
    sourceUrl: toSourceUrl(thing),
    averageRating: thing.statistics?.ratings?.average,
    minPlayers: thing.minplayers,
    maxPlayers: thing.maxplayers,
    baseGameExternalId: toBaseGameExternalId(thing),
    summary: thing.description,
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

  const designers = linksOfType(thing, BggLinkType.BoardGameDesigner).map(toPersonData);
  const artists = linksOfType(thing, BggLinkType.BoardGameArtist).map(toPersonData);
  const publishers = linksOfType(thing, BggLinkType.BoardGamePublisher).map(toPublisherData);
  const mechanics = linksOfType(thing, BggLinkType.BoardGameMechanic).map(toMechanicData);
  const categories = linksOfType(thing, BggLinkType.BoardGameCategory).map(toCategoryData);
  const families = linksOfType(thing, BggLinkType.BoardGameFamily).map(toFamilyData);

  return {
    externalId: String(thing.id),
    title,
    contentType: toContentType(thing),

    description: thing.description,
    yearPublished: thing.yearpublished,
    thumbnailUrl: thing.thumbnail,
    imageUrl: thing.image,
    sourceUrl: toSourceUrl(thing),

    designers,
    artists,
    publishers,
    mechanics,
    categories,
    families,

    averageRating: ratings?.average,
    bayesRating: ratings?.bayesaverage,
    ratingsCount: ratings?.usersrated,
    minPlayers: thing.minplayers,
    maxPlayers: thing.maxplayers,
    minPlaytime: thing.minplaytime ?? thing.playingtime,
    maxPlaytime: thing.maxplaytime ?? thing.playingtime,
    minAge: thing.minage,
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
