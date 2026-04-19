/**
 * Shapes returned by the IGDB API
 *
 * Only fields requested by BGE are typed here. IGDB enum values are documented
 * inline; the full reference is at https://api-docs.igdb.com
 */

export interface IgdbCover {
  id: number;

  /**
   * Protocol-relative URL: //images.igdb.com/igdb/image/upload/<size>/<hash>.jpg
   */
  url: string;
}

export interface IgdbWebsite {
  url: string;
}

export interface IgdbNamedEntity {
  id: number;
  name: string;
}

/**
 * Partial parent reference embedded in expansions / DLCs.
 */
export interface IgdbGameRef {
  id: number;
}

export interface IgdbCompany {
  id: number;
  name: string;
  websites?: IgdbWebsite[];
}

export interface IgdbInvolvedCompany {
  id: number;
  company: IgdbCompany;
  developer: boolean;
  publisher: boolean;
}

/**
 * IGDB platform_category enum values:
 *   1 = console
 *   2 = arcade
 *   3 = platform (generic)
 *   4 = operating_system  → maps to PC
 *   5 = portable_console
 *   6 = computer          → maps to PC
 *   7 = mobile
 */
export type IgdbPlatformType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | number;

export interface IgdbPlatform {
  id: number;
  name: string;
  abbreviation?: string;

  /**
   * See IgdbPlatformType for values.
   */
  platform_type?: IgdbPlatformType;
}

/**
 * IGDB region enum values:
 *   1=Europe  2=North America  3=Australia  4=New Zealand
 *   5=Japan   6=China          7=Asia       8=Worldwide
 *   9=Korea   10=Brazil
 */
export type IgdbRegion = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | number;

export interface IgdbReleaseDate {
  id: number;
  platform: IgdbPlatform;

  /**
   * Unix timestamp (seconds). Present when IGDB has a precise date.
   */
  date?: number;

  /**
   * Human-readable date string from IGDB (e.g. "Apr 23, 2019", "2020 Q3").
   */
  human?: string;

  region?: IgdbRegion;
}

/**
 * IGDB language object nested inside language_supports.
 * id corresponds to the stable IDs in the IGDB_LANGUAGES registry.
 */
export interface IgdbLanguageEntry {
  id: number;
  name: string;
  native_name?: string;
  locale?: string;
}

/**
 * language_support_type enum:
 *   1 = audio
 *   2 = subtitles
 *   3 = interface
 */
export type IgdbLanguageSupportType = 1 | 2 | 3 | number;

export interface IgdbLanguageSupport {
  id: number;
  language: IgdbLanguageEntry;
  language_support_type?: IgdbLanguageSupportType;
}

/**
 * IGDB age_rating organization (the certifying authority):
 *   1=ESRB  2=PEGI  3=CERO  5=USK  6=GRAC  7=CLASS_IND  8=ACB
 */
export type IgdbAgeRatingOrganization = 1 | 2 | 3 | 5 | 6 | 7 | 8 | number;

/**
 * IGDB age_rating rating (globally-unique numeric enum across all authorities):
 *
 * PEGI:  1=3   2=7   3=12  4=16  5=18
 * ESRB:  6=RP  7=EC  8=E   9=E10+  10=T  11=M  12=AO
 * CERO:  13=A  14=B  15=C  16=D    17=Z
 * USK:   18=0  19=6  20=12  21=16  22=18
 * ACB:   34=G  35=PG 36=M  37=MA15+  38=R18+  39=RC
 */
export type IgdbAgeRatingValue = number;

export interface IgdbAgeRating {
  id: number;

  /**
   * Authority identifier. See IgdbAgeRatingOrganization.
   */
  organization: IgdbAgeRatingOrganization;

  /**
   * Numeric rating value. See IgdbAgeRatingValue.
   */
  rating_category: IgdbAgeRatingValue;

  synopsis?: string;
}

/**
 * IGDB `category` enum values:
 *   0 = main_game
 *   1 = dlc_addon
 *   2 = expansion
 *   3 = bundle
 *   4 = standalone_expansion
 *   5 = mod
 *   6 = episode
 *   7 = season
 *   8 = remake
 *   9 = remaster
 *  10 = expanded_game
 *  11 = port
 *  12 = fork
 */
export type IgdbGameType = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | number;

/**
 * IGDB `status` enum values (game-level release status):
 *   0 = released
 *   2 = alpha
 *   3 = beta
 *   4 = early_access
 *   5 = offline
 *   6 = cancelled
 *   7 = rumoured
 *   8 = delisted
 */
export type IgdbGameStatus = 0 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | number;

export interface IgdbGame {
  id: number;
  name: string;
  game_type?: IgdbGameType;
  game_status?: IgdbGameStatus;

  /**
   * Unix timestamp
   */
  first_release_date?: number;

  age_ratings?: IgdbAgeRating[];
  collections?: IgdbNamedEntity[];
  cover?: IgdbCover;
  franchises?: IgdbNamedEntity[];
  genres?: IgdbNamedEntity[];
  involved_companies?: IgdbInvolvedCompany[];
  language_supports?: IgdbLanguageSupport[];
  platforms?: IgdbPlatform[];
  release_dates?: IgdbReleaseDate[];
  summary?: string;
  themes?: IgdbNamedEntity[];
  total_rating_count?: number;
  total_rating?: number;
  url?: string;

  /**
   * Populated on DLC (category 1) and expansion (category 2).
   */
  parent_game?: IgdbGameRef | number;

  /**
   * Populated on standalone expansion (category 4) and version entries.
   */
  version_parent?: IgdbGameRef | number;
}
