import * as proto from '@board-games-empire/proto-gateway';
import { DateTime } from 'luxon';
import type {
  IgdbAgeRating,
  IgdbAgeRatingOrganization,
  IgdbGame,
  IgdbGameType,
  IgdbLanguageEntry,
  IgdbNamedEntity,
  IgdbPlatform,
  IgdbReleaseDate,
} from '../types';
import { toLanguageData } from './language.mapper';

/**
 * IGDB returns protocol-relative URLs (//images.igdb.com/...).
 * Prepend 'https:' to produce a valid absolute URL.
 */
function toAbsoluteUrl(url: string): string {
  return url.startsWith('//') ? `https:${url}` : url;
}

function resizeCoverUrl(url: string, size: string): string {
  return toAbsoluteUrl(url).replace(/t_[a-z0-9_]+/, size);
}

function toIsoDate(unixSeconds: number): string {
  return <string>DateTime.fromSeconds(unixSeconds).toISODate();
}

/**
 * Maps IGDB `category` to the proto ContentType.
 *
 * IGDB values not covered (mod=5, episode=6, season=7, expanded_game=10,
 * port=11, fork=12) have no direct BGE equivalent and fall through to
 * CONTENT_TYPE_UNSPECIFIED.
 */
const IGDB_CONTENT_TYPE_MAP: Readonly<Partial<Record<IgdbGameType, proto.ContentType>>> = {
  0: proto.ContentType.CONTENT_TYPE_BASE_GAME,
  1: proto.ContentType.CONTENT_TYPE_DLC,
  2: proto.ContentType.CONTENT_TYPE_EXPANSION,
  3: proto.ContentType.CONTENT_TYPE_BUNDLE,
  4: proto.ContentType.CONTENT_TYPE_STANDALONE_EXPANSION,
  8: proto.ContentType.CONTENT_TYPE_REMAKE,
  9: proto.ContentType.CONTENT_TYPE_REMASTER,
};

function toContentType(category: IgdbGameType | undefined): proto.ContentType {
  return (category !== undefined && IGDB_CONTENT_TYPE_MAP[category]) || proto.ContentType.CONTENT_TYPE_UNSPECIFIED;
}

/**
 * IGDB platform_category → proto PlatformType.
 * Values 4 (operating_system) and 6 (computer) both map to PC.
 */
const IGDB_PLATFORM_TYPE_MAP: Readonly<Record<number, proto.PlatformType>> = {
  1: proto.PlatformType.PLATFORM_TYPE_CONSOLE,
  2: proto.PlatformType.PLATFORM_TYPE_ARCADE,
  3: proto.PlatformType.PLATFORM_TYPE_OTHER,
  4: proto.PlatformType.PLATFORM_TYPE_PC,
  5: proto.PlatformType.PLATFORM_TYPE_PORTABLE,
  6: proto.PlatformType.PLATFORM_TYPE_PC,
  7: proto.PlatformType.PLATFORM_TYPE_MOBILE,
};

function toPlatformData(platform: IgdbPlatform): proto.PlatformData {
  return {
    externalId: String(platform.id),
    name: platform.name,
    abbreviation: platform.abbreviation,
    platformType:
      (platform.platform_type !== undefined && IGDB_PLATFORM_TYPE_MAP[platform.platform_type]) ||
      proto.PlatformType.PLATFORM_TYPE_OTHER,
  };
}

/**
 * IGDB game-level `status` → proto ReleaseStatus.
 * Applied uniformly to all release entries for that game.
 */
const IGDB_RELEASE_STATUS_MAP: Readonly<Record<number, proto.ReleaseStatus>> = {
  0: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
  2: proto.ReleaseStatus.RELEASE_STATUS_ALPHA,
  3: proto.ReleaseStatus.RELEASE_STATUS_BETA,
  4: proto.ReleaseStatus.RELEASE_STATUS_EARLY_ACCESS,
  5: proto.ReleaseStatus.RELEASE_STATUS_OFFLINE,
  6: proto.ReleaseStatus.RELEASE_STATUS_CANCELLED,
  7: proto.ReleaseStatus.RELEASE_STATUS_RUMOURED,
  8: proto.ReleaseStatus.RELEASE_STATUS_DELISTED,
};

function toReleaseStatus(igdbStatus: number | undefined): proto.ReleaseStatus {
  return (
    (igdbStatus !== undefined && IGDB_RELEASE_STATUS_MAP[igdbStatus]) || proto.ReleaseStatus.RELEASE_STATUS_UNSPECIFIED
  );
}

/**
 * IGDB region enum (1-10) → proto RegionData.
 * externalId is the string representation of the IGDB region enum value.
 */
const IGDB_REGION_MAP: Readonly<Record<number, Omit<proto.RegionData, 'externalId'>>> = {
  1: { name: 'Europe', regionCode: 'eu' },
  2: { name: 'North America', regionCode: 'us' },
  3: { name: 'Australia', regionCode: 'au' },
  4: { name: 'New Zealand', regionCode: 'nz' },
  5: { name: 'Japan', regionCode: 'jp' },
  6: { name: 'China', regionCode: 'cn' },
  7: { name: 'Asia', regionCode: 'as' },
  8: { name: 'Worldwide', regionCode: 'ww' },
  9: { name: 'Korea', regionCode: 'kr' },
  10: { name: 'Brazil', regionCode: 'br' },
};

function toRegionData(igdbRegion: number): proto.RegionData {
  const known = IGDB_REGION_MAP[igdbRegion];
  return known
    ? { externalId: String(igdbRegion), ...known }
    : { externalId: String(igdbRegion), name: `Region ${igdbRegion}`, regionCode: String(igdbRegion) };
}

/**
 * Groups IGDB's flat release_dates list by platform, producing one
 * GameReleaseData per platform. Each regional entry within that platform
 * becomes a LocalizationData.
 *
 * IGDB does not provide localized titles — localizedTitle is always undefined.
 * The game-level status is applied uniformly to all releases.
 */
function toGameReleaseDataList(
  releaseDates: IgdbReleaseDate[],
  gameStatus: number | undefined,
  languages: proto.LanguageData[],
): proto.GameReleaseData[] {
  const byPlatform = new Map<number, { platform: IgdbPlatform; entries: IgdbReleaseDate[] }>();

  for (const rd of releaseDates) {
    const existing = byPlatform.get(rd.platform.id);
    if (existing) {
      existing.entries.push(rd);
    } else {
      byPlatform.set(rd.platform.id, { platform: rd.platform, entries: [rd] });
    }
  }

  const status = toReleaseStatus(gameStatus);

  return Array.from(byPlatform.values()).map(({ platform, entries }) => {
    // Use the Worldwide entry date as the canonical release date when present;
    // otherwise take the earliest available date.
    const worldwide = entries.find((e) => e.region === 8);
    const primaryEntry = worldwide ?? entries.reduce((a, b) => ((a.date ?? Infinity) < (b.date ?? Infinity) ? a : b));
    const releaseDate = primaryEntry.date ? toIsoDate(primaryEntry.date) : primaryEntry.human;

    const localizations: proto.LocalizationData[] = entries
      .filter((e) => e.region !== undefined)
      .map((e) => ({
        region: toRegionData(e.region!),
        releaseDate: e.date ? toIsoDate(e.date) : e.human,
      }));

    return {
      externalId: String(primaryEntry.id),
      platform: toPlatformData(platform),
      status,
      releaseDate,
      localizations,
      languages,
    } satisfies proto.GameReleaseData;
  });
}

/**
 * IGDB age_rating `category` field (the authority) → proto AgeRatingAuthority.
 *   1=ESRB  2=PEGI  3=CERO  5=USK  8=ACB
 * IGDB values 6 (GRAC) and 7 (CLASS_IND) have no BGE equivalent.
 */
const IGDB_AGE_RATING_AUTHORITY_MAP: Readonly<Partial<Record<IgdbAgeRatingOrganization, proto.AgeRatingAuthority>>> = {
  1: proto.AgeRatingAuthority.AGE_RATING_AUTHORITY_ESRB,
  2: proto.AgeRatingAuthority.AGE_RATING_AUTHORITY_PEGI,
  3: proto.AgeRatingAuthority.AGE_RATING_AUTHORITY_CERO,
  5: proto.AgeRatingAuthority.AGE_RATING_AUTHORITY_USK,
  8: proto.AgeRatingAuthority.AGE_RATING_AUTHORITY_ACB,
};

/**
 * Globally-unique IGDB rating enum value → human-readable label.
 * Values sourced from the IGDB age_ratings enum documentation.
 */
const IGDB_RATING_LABEL_MAP: Readonly<Record<number, string>> = {
  // PEGI
  1: 'PEGI 3',
  2: 'PEGI 7',
  3: 'PEGI 12',
  4: 'PEGI 16',
  5: 'PEGI 18',

  // ESRB
  6: 'RP',
  7: 'EC',
  8: 'E',
  9: 'E10+',
  10: 'T',
  11: 'M',
  12: 'AO',

  // CERO
  13: 'A',
  14: 'B',
  15: 'C',
  16: 'D',
  17: 'Z',

  // USK
  18: 'USK 0',
  19: 'USK 6',
  20: 'USK 12',
  21: 'USK 16',
  22: 'USK 18',

  // ACB (Australia)
  34: 'G',
  35: 'PG',
  36: 'M',
  37: 'MA15+',
  38: 'R18+',
  39: 'RC',
};

function toAgeRatingData(rating: IgdbAgeRating): proto.AgeRatingData | null {
  const authority = IGDB_AGE_RATING_AUTHORITY_MAP[rating.organization];
  if (!authority) return null; // GRAC, CLASS_IND — not in proto

  return {
    authority,
    rating: IGDB_RATING_LABEL_MAP[rating.rating_category] ?? String(rating.rating_category),
    synopsis: rating.synopsis,
  };
}

function toGenreData(entity: IgdbNamedEntity): proto.GenreData {
  return { externalId: String(entity.id), name: entity.name };
}

function toThemeData(entity: IgdbNamedEntity): proto.ThemeData {
  return { externalId: String(entity.id), name: entity.name };
}

function toCategoryData(entity: IgdbNamedEntity): proto.CategoryData {
  return { externalId: String(entity.id), name: entity.name };
}

function toBaseGameExternalId(game: IgdbGame): string | undefined {
  const ref = game.parent_game ?? game.version_parent;
  return ref ? String(ref.id) : undefined;
}

function toYearPublished(unixSeconds: number | undefined): number | undefined {
  return unixSeconds !== undefined ? new Date(unixSeconds * 1000).getFullYear() : undefined;
}

/**
 * Maps an IgdbGame to the lean GameSearchData used in streaming search results.
 * `availablePlatforms` allows the client to render platform chips on the
 * search card without a subsequent FetchGame round-trip.
 */
export function toGameSearchData(game: IgdbGame): proto.GameSearchData {
  const languages = toLanguageDataList((game.language_supports ?? []).map((ls) => ls.language));
  const availableReleases = toGameReleaseDataList(
    // Search data doesn't have release_dates — produce one release per
    // platform using platform-level data only, no localization detail.
    (game.platforms ?? []).map((p) => ({
      id: p.id,
      platform: p,
      region: undefined,
      date: game.first_release_date,
    })),
    game.game_status,
    languages,
  );

  return {
    externalId: String(game.id),
    title: game.name,
    contentType: toContentType(game.game_type),
    yearPublished: toYearPublished(game.first_release_date),
    thumbnailUrl: game.cover ? resizeCoverUrl(game.cover.url, 't_cover_big') : undefined,
    sourceUrl: game.url,
    averageRating: game.total_rating,
    summary: game.summary,
    availablePlatforms: (game.platforms ?? []).map(toPlatformData),
    availableReleases,
    baseGameExternalId: toBaseGameExternalId(game),
  };
}

/**
 * Maps an IgdbGame to the full GameData used by the import worker.
 *
 * IGDB-specific notes:
 * - `artists` is always empty (IGDB has no separate artist role).
 * - `mechanics` is always empty (IGDB has no equivalent concept).
 * - `bayesRating`, `minPlayers`, `maxPlayers`, `minPlaytime`, `maxPlaytime`,
 *   `minAge`, `complexityWeight` are board-game fields with no IGDB equivalent.
 */
export function toGameData(game: IgdbGame): proto.GameData {
  const designers: proto.PersonData[] = (game.involved_companies ?? [])
    .filter((ic) => ic.developer)
    .map((ic) => ({ externalId: String(ic.company.id), name: ic.company.name }));

  const publishers: proto.PublisherData[] = (game.involved_companies ?? [])
    .filter((ic) => ic.publisher)
    .map((ic) => ({
      externalId: String(ic.company.id),
      name: ic.company.name,
      website: ic.company.websites?.[0]?.url,
    }));

  const families: proto.FamilyData[] = [
    ...(game.franchises ?? []).map((f) => ({
      ...toCategoryData(f),
      familyType: 'franchise',
    })),
    ...(game.collections ?? []).map((c) => ({
      ...toCategoryData(c),
      familyType: 'collection',
    })),
  ];

  const categories: proto.CategoryData[] = (game.genres ?? []).map(toCategoryData);
  const languages = toLanguageDataList((game.language_supports ?? []).map((ls) => ls.language));
  const platforms = (game.platforms ?? []).map(toPlatformData);
  const releases = toGameReleaseDataList(game.release_dates ?? [], game.game_status, languages);

  const themes = (game.themes ?? []).map(toThemeData);
  const ageRatings: proto.AgeRatingData[] = (game.age_ratings ?? [])
    .map(toAgeRatingData)
    .filter((r): r is proto.AgeRatingData => r !== null);

  return {
    ageRatings,
    artists: [],
    averageRating: game.total_rating,
    baseGameExternalId: toBaseGameExternalId(game),

    categories,
    contentType: toContentType(game.game_type),
    description: game.summary,
    designers,
    dlc: [],

    externalId: String(game.id),
    families,
    imageUrl: game.cover ? resizeCoverUrl(game.cover.url, 't_screenshot_big') : undefined,

    mechanics: [],
    metadataKeys: [],
    metadataValues: [],

    platforms,
    publishers,
    ratingsCount: game.total_rating_count,
    releases,

    sourceUrl: game.url,
    summary: game.summary,

    themes,
    thumbnailUrl: game.cover ? resizeCoverUrl(game.cover.url, 't_cover_big') : undefined,
    title: game.name,

    yearPublished: toYearPublished(game.first_release_date),
  };
}

/**
 * Deduplicates LanguageData by iso639_3 so en-US and en-GB don't both appear.
 * The first encountered entry wins — for display purposes they're equivalent.
 */
function toLanguageDataList(languageEntries: IgdbLanguageEntry[]): proto.LanguageData[] {
  const seen = new Set<string>();
  const result: proto.LanguageData[] = [];

  for (const entry of languageEntries) {
    const mapped = toLanguageData(entry);
    if (mapped && !seen.has(mapped.iso6393)) {
      seen.add(mapped.iso6393);
      result.push(mapped);
    }
  }

  return result;
}
