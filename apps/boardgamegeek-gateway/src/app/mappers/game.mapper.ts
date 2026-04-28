import * as proto from '@board-games-empire/proto-gateway';
import { BggLinkType, BggNameType, BggThingType } from '../constants';
import type { BggLink, BggName, BggSearchItem, BggThing } from '../types';

/**
 * BGG `type` → proto ContentType.
 *
 * BGE imports board games and their expansions through this gateway;
 * accessories are out of scope and fall through to UNSPECIFIED.
 */
const BGG_CONTENT_TYPE_MAP: Readonly<Record<string, proto.ContentType>> = {
  [BggThingType.BoardGame]: proto.ContentType.CONTENT_TYPE_BASE_GAME,
  [BggThingType.BoardGameExpansion]: proto.ContentType.CONTENT_TYPE_EXPANSION,
  [BggThingType.BoardGameAccessory]: proto.ContentType.CONTENT_TYPE_ACCESSORY,
};

/**
 * Complexity weight is stored on `Game.complexityWeight` as an integer
 * scaled by 1000 to avoid float-precision issues. BGG returns a float
 * in [1.0, 5.0] — multiply and round.
 */
const COMPLEXITY_WEIGHT_SCALE = 1000;

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
 *
 * Inbound links are excluded — those represent the inverse relationship
 * (the thing IS an expansion of the linked id) and would otherwise be
 * mistaken for the thing's own expansions during a `fetchExpansions`
 * orchestration in the gateway service.
 */
export function getOutboundExpansionIds(thing: Pick<BggThing, 'links'>): number[] {
  return (thing.links ?? [])
    .filter((link) => link.type === BggLinkType.BoardGameExpansion && !isInbound(link.inbound))
    .map((link) => link.id);
}

function toContentType(thing: Pick<BggThing, 'type'>): proto.ContentType {
  return BGG_CONTENT_TYPE_MAP[thing.type] ?? proto.ContentType.CONTENT_TYPE_UNSPECIFIED;
}

/**
 * Resolves the base-game external id when this thing is itself an
 * expansion. BGG records this with an inbound `boardgameexpansion`
 * link pointing at the base game.
 */
function toBaseGameExternalId(thing: Pick<BggThing, 'links'>): string | undefined {
  const inboundExpansion = (thing.links ?? []).find(
    (link) => link.type === BggLinkType.BoardGameExpansion && isInbound(link.inbound),
  );
  return inboundExpansion ? String(inboundExpansion.id) : undefined;
}

/**
 * Builds the canonical BGG source URL for a thing. BGG URLs differ by
 * type (`/boardgame/`, `/boardgameexpansion/`, …) so we route through
 * the type field.
 */
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
 * Maps a BGG family link to proto `FamilyData`. BGG encodes a
 * sub-classification in the value's `"<Type>: <n>"` prefix
 * (e.g. `"Game: Catan Series"`); the prefix is parsed into
 * `familyType` so downstream callers can group families consistently.
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
 * Builds a synthetic Tabletop release for a BGG game. BGG models
 * board games as platform-less things, but BGE's data model expects
 * every imported game to carry at least one release record. Emitting
 * a single Tabletop release with the year-published as the release
 * date keeps the import worker's release-upsert path uniform across
 * gateways.
 */
function toTabletopRelease(thing: Pick<BggThing, 'id' | 'yearpublished'>): proto.GameReleaseData {
  const releaseDate = thing.yearpublished ? `${thing.yearpublished}-01-01` : undefined;

  return {
    externalId: `bgg-${thing.id}-tabletop`,
    platform: TABLETOP_PLATFORM,
    status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
    releaseDate,
    localizations: [],
    languages: [],
  } satisfies proto.GameReleaseData;
}

const TABLETOP_PLATFORM: proto.PlatformData = {
  externalId: 'bgg-tabletop',
  name: 'Tabletop',
  abbreviation: 'TT',
  platformType: proto.PlatformType.PLATFORM_TYPE_TABLETOP,
};

/**
 * Maps a BGG search-result item to the lean proto `GameSearchData`.
 *
 * Search responses do not carry thumbnails, ratings, player counts, or
 * description — those fields stay undefined here and are populated by
 * a follow-up `FetchGame` call.
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
 * Maps a fully-detailed BGG `thing` (used for expansion streaming) to
 * the lean proto `GameSearchData`. Richer than the search-item mapper
 * because the thing endpoint carries thumbnails, ratings, and player
 * counts.
 */
export function thingToGameSearchData(thing: BggThing): proto.GameSearchData {
  const title = selectPrimaryName(thing.names) ?? '';

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
    availableReleases: [toTabletopRelease(thing)],
  } satisfies proto.GameSearchData;
}

/**
 * Maps a fully-detailed BGG `thing` to the proto `GameData` consumed by
 * the import worker.
 *
 * BGG-specific notes:
 *  - `themes`, `ageRatings`, `dlc` are always empty (BGG has no
 *    equivalent concepts for board games).
 *  - `complexityWeight` is scaled by 1000 to fit the proto's int32
 *    contract.
 *  - Releases collapse to a single synthetic Tabletop entry — BGG does
 *    not differentiate platforms within the board-game domain.
 */
export function thingToGameData(thing: BggThing): proto.GameData {
  const title = selectPrimaryName(thing.names) ?? '';
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
    releases: [toTabletopRelease(thing)],

    themes: [],
    ageRatings: [],
    summary: undefined,

    metadataKeys: [],
    metadataValues: [],

    dlc: [],
  } satisfies proto.GameData;
}
