import * as proto from '@board-games-empire/proto-gateway';
import { DateTime } from 'luxon';
import { AgeRatingOrganization, GameStatus, GameType, OrganizationRating, PlatformType, Region } from '../constants';
import type {
  IgdbAgeRating,
  IgdbGame,
  IgdbGameType,
  IgdbLanguageEntry,
  IgdbNamedEntity,
  IgdbPlatform,
  IgdbReleaseDate,
} from '../types';
import { resolveLanguageIds, toLanguageData } from './language.mapper';

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
  [GameType.MainGame]: proto.ContentType.CONTENT_TYPE_BASE_GAME,
  [GameType.DLC]: proto.ContentType.CONTENT_TYPE_DLC,
  [GameType.Expansion]: proto.ContentType.CONTENT_TYPE_EXPANSION,
  [GameType.Bundle]: proto.ContentType.CONTENT_TYPE_BUNDLE,
  [GameType.StandaloneExpansion]: proto.ContentType.CONTENT_TYPE_STANDALONE_EXPANSION,
  [GameType.Remake]: proto.ContentType.CONTENT_TYPE_REMAKE,
  [GameType.Remaster]: proto.ContentType.CONTENT_TYPE_REMASTER,

  [GameType.Episode]: proto.ContentType.CONTENT_TYPE_DLC,
  [GameType.Season]: proto.ContentType.CONTENT_TYPE_BUNDLE,
  [GameType.ExpandedEdition]: proto.ContentType.CONTENT_TYPE_EXPANDED_EDITION,
  [GameType.Port]: proto.ContentType.CONTENT_TYPE_PORT,
  [GameType.Fork]: proto.ContentType.CONTENT_TYPE_BASE_GAME,
  [GameType.PackAddon]: proto.ContentType.CONTENT_TYPE_DLC,
  [GameType.Mod]: proto.ContentType.CONTENT_TYPE_MOD,
};

function toContentType(category: IgdbGameType | undefined): proto.ContentType {
  return (category !== undefined && IGDB_CONTENT_TYPE_MAP[category]) || proto.ContentType.CONTENT_TYPE_UNSPECIFIED;
}

/**
 * IGDB platform_type → proto PlatformType.
 * Values 4 (operating_system) and 6 (computer) both map to PC.
 *
 * @see https://api-docs.igdb.com/#platform
 */
const IGDB_PLATFORM_TYPE_MAP: Readonly<Record<number, proto.PlatformType>> = {
  [PlatformType.Console]: proto.PlatformType.PLATFORM_TYPE_CONSOLE,
  [PlatformType.Arcade]: proto.PlatformType.PLATFORM_TYPE_ARCADE,
  [PlatformType.Platform]: proto.PlatformType.PLATFORM_TYPE_OTHER,
  [PlatformType.OperatingSystem]: proto.PlatformType.PLATFORM_TYPE_PC,
  [PlatformType.PortableConsole]: proto.PlatformType.PLATFORM_TYPE_PORTABLE,
  [PlatformType.Computer]: proto.PlatformType.PLATFORM_TYPE_PC,
};

function toPlatformData(platform: IgdbPlatform): proto.PlatformData {
  const pcTypes: number[] = [PlatformType.OperatingSystem, PlatformType.Computer];
  const mobile = ['iOS', 'Android'];
  const platformType =
    pcTypes.includes(platform.platform_type ?? 0) && mobile.includes(platform.name)
      ? proto.PlatformType.PLATFORM_TYPE_MOBILE
      : IGDB_PLATFORM_TYPE_MAP[platform.platform_type ?? 0] || proto.PlatformType.PLATFORM_TYPE_OTHER;

  return {
    externalId: String(platform.id),
    name: platform.name,
    abbreviation: platform.abbreviation,
    platformType,
  };
}

/**
 * IGDB game-level `status` → proto ReleaseStatus.
 * Applied uniformly to all release entries for that game.
 */
const IGDB_RELEASE_STATUS_MAP: Readonly<Record<number, proto.ReleaseStatus>> = {
  [GameStatus.Released]: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
  [GameStatus.Alpha]: proto.ReleaseStatus.RELEASE_STATUS_ALPHA,
  [GameStatus.Beta]: proto.ReleaseStatus.RELEASE_STATUS_BETA,
  [GameStatus.EarlyAccess]: proto.ReleaseStatus.RELEASE_STATUS_EARLY_ACCESS,
  [GameStatus.Offline]: proto.ReleaseStatus.RELEASE_STATUS_OFFLINE,
  [GameStatus.Cancelled]: proto.ReleaseStatus.RELEASE_STATUS_CANCELLED,
  [GameStatus.Rumored]: proto.ReleaseStatus.RELEASE_STATUS_RUMOURED,
  [GameStatus.Delisted]: proto.ReleaseStatus.RELEASE_STATUS_DELISTED,
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
  [Region.Europe]: { name: 'Europe', regionCode: 'eu' },
  [Region.NorthAmerica]: { name: 'North America', regionCode: 'us' },
  [Region.Australia]: { name: 'Australia', regionCode: 'au' },
  [Region.NewZealand]: { name: 'New Zealand', regionCode: 'nz' },
  [Region.Japan]: { name: 'Japan', regionCode: 'jp' },
  [Region.China]: { name: 'China', regionCode: 'cn' },
  [Region.Asia]: { name: 'Asia', regionCode: 'as' },
  [Region.Worldwide]: { name: 'Worldwide', regionCode: 'ww' },
  [Region.Korea]: { name: 'Korea', regionCode: 'kr' },
  [Region.Brazil]: { name: 'Brazil', regionCode: 'br' },
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
    const worldwide = entries.find((e) => e.region === Region.Worldwide);
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
      status: releaseStatusFromDate(status, releaseDate),
      releaseDate,
      localizations,
      languages,
    } satisfies proto.GameReleaseData;
  });
}

function releaseStatusFromDate(
  currentStatus: proto.ReleaseStatus,
  releaseDate: string | undefined,
): proto.ReleaseStatus {
  if (!releaseDate || currentStatus !== proto.ReleaseStatus.RELEASE_STATUS_UNSPECIFIED) {
    return currentStatus;
  }

  const now = DateTime.now();
  const release = DateTime.fromISO(releaseDate);
  return release < now ? proto.ReleaseStatus.RELEASE_STATUS_RELEASED : currentStatus;
}

/**
 * IGDB age_rating `category` field (the authority) → proto AgeRatingAuthority.
 */
const IGDB_AGE_RATING_AUTHORITY_MAP: Readonly<Partial<Record<AgeRatingOrganization, proto.AgeRatingAuthority>>> = {
  [AgeRatingOrganization.ESRB]: proto.AgeRatingAuthority.AGE_RATING_AUTHORITY_ESRB,
  [AgeRatingOrganization.PEGI]: proto.AgeRatingAuthority.AGE_RATING_AUTHORITY_PEGI,
  [AgeRatingOrganization.CERO]: proto.AgeRatingAuthority.AGE_RATING_AUTHORITY_CERO,
  [AgeRatingOrganization.USK]: proto.AgeRatingAuthority.AGE_RATING_AUTHORITY_USK,
  [AgeRatingOrganization.ACB]: proto.AgeRatingAuthority.AGE_RATING_AUTHORITY_ACB,
};

/**
 * Globally-unique IGDB rating enum value → human-readable label.
 * Values sourced from the IGDB age_ratings enum documentation.
 */
const IGDB_RATING_LABEL_MAP: Readonly<Record<number, string>> = {
  // PEGI
  [OrganizationRating.PEGI_3]: 'PEGI 3',
  [OrganizationRating.PEGI_7]: 'PEGI 7',
  [OrganizationRating.PEGI_12]: 'PEGI 12',
  [OrganizationRating.PEGI_16]: 'PEGI 16',
  [OrganizationRating.PEGI_18]: 'PEGI 18',

  // ESRB
  [OrganizationRating.ESRB_RP]: 'RP',
  [OrganizationRating.ESRB_EC]: 'EC',
  [OrganizationRating.ESRB_E]: 'E',
  [OrganizationRating.ESRB_E10]: 'E10+',
  [OrganizationRating.ESRB_T]: 'T',
  [OrganizationRating.ESRB_M]: 'M',
  [OrganizationRating.ESRB_AO]: 'AO',

  // CERO
  [OrganizationRating.CERO_A]: 'A',
  [OrganizationRating.CERO_B]: 'B',
  [OrganizationRating.CERO_C]: 'C',
  [OrganizationRating.CERO_D]: 'D',
  [OrganizationRating.CERO_Z]: 'Z',

  // USK
  [OrganizationRating.USK_0]: 'USK 0',
  [OrganizationRating.USK_6]: 'USK 6',
  [OrganizationRating.USK_12]: 'USK 12',
  [OrganizationRating.USK_16]: 'USK 16',
  [OrganizationRating.USK_18]: 'USK 18',

  [OrganizationRating.GRAC_ALL]: 'GRAC ALL',
  [OrganizationRating.GRAC_12]: 'GRAC 12',
  [OrganizationRating.GRAC_15]: 'GRAC 15',
  [OrganizationRating.GRAC_18]: 'GRAC 18',
  [OrganizationRating.GRAC_19]: 'GRAC 19',

  // CLASS IND (Brazil)
  [OrganizationRating.CLASS_IND_L]: 'L',
  [OrganizationRating.CLASS_IND_10]: '10',
  [OrganizationRating.CLASS_IND_12]: '12',
  [OrganizationRating.CLASS_IND_14]: '14',
  [OrganizationRating.CLASS_IND_16]: '16',
  [OrganizationRating.CLASS_IND_18]: '18',

  // ACB (Australia)
  [OrganizationRating.ACB_G]: 'G',
  [OrganizationRating.ACB_PG]: 'PG',
  [OrganizationRating.ACB_M]: 'M',
  [OrganizationRating.ACB_MA15]: 'MA15+',
  [OrganizationRating.ACB_R18]: 'R18+',
  [OrganizationRating.ACB_RC]: 'RC',
};

function toAgeRatingData(rating: IgdbAgeRating): proto.AgeRatingData | null {
  const authority = IGDB_AGE_RATING_AUTHORITY_MAP[rating.organization];
  if (!authority) {
    return null;
  }

  return {
    authority,
    rating: IGDB_RATING_LABEL_MAP[rating.rating_category] ?? String(rating.rating_category),
    synopsis: rating.synopsis,
  } satisfies proto.AgeRatingData;
}

function toThemeData(entity: IgdbNamedEntity): proto.ThemeData {
  return {
    externalId: String(entity.id),
    name: entity.name,
  } satisfies proto.ThemeData;
}

function toCategoryData(entity: IgdbNamedEntity): proto.CategoryData {
  return {
    externalId: String(entity.id),
    name: entity.name,
  } satisfies proto.CategoryData;
}

function toBaseGameExternalId(game: IgdbGame): string | undefined {
  const ref = game.parent_game ?? game.version_parent;
  return typeof ref === 'number' ? String(ref) : undefined;
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
export function toGameData(game: IgdbGame, locale?: string): proto.GameData {
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

  const allowedLanguageIds = resolveLanguageIds(locale);
  const categories: proto.CategoryData[] = (game.genres ?? []).map(toCategoryData);
  const languages = toLanguageDataList(
    (game.language_supports ?? []).map((ls) => ls.language).filter((lang) => filterLocale(lang, allowedLanguageIds)),
  );

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
    imageUrl: game.cover ? resizeCoverUrl(game.cover.url, 't_cover_big_2x') : undefined,

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

function filterLocale(lang: IgdbLanguageEntry, languageIds: number[]): boolean {
  if (languageIds.length === 0) {
    return true;
  }

  return languageIds.includes(lang.id);
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
