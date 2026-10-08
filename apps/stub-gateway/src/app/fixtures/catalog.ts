import * as proto from '@boardgamesempire/proto-gateway';

/**
 * Everything the stub knows: two games of its own invention, shaped as the
 * BoardGameGeek gateway shapes a board game, and one language. Every
 * identifier is prefixed `stub-`, so nothing here can be mistaken for, or
 * collide with, a record from a real source.
 *
 * No game carries an image or a source URL: an import that followed one
 * would leave the machine, and the stub exists so that nothing does.
 *
 * Add a game or a language when a test needs one; the service serves
 * whatever is listed here.
 */

const ENGLISH: proto.LanguageData = {
  name: 'English',
  ietfTag: 'en-US',
  iso6391: 'en',
  iso6393: 'eng',
};

const TABLETOP: proto.PlatformData = {
  externalId: 'stub-tabletop',
  name: 'Tabletop',
  abbreviation: 'TT',
  platformType: proto.PlatformType.PLATFORM_TYPE_TABLETOP,
};

/** One edition, the default one, as a source without edition data sends it. */
const defaultRelease = (releaseDate: string): proto.GameReleaseData => ({
  externalId: 'default',
  platform: TABLETOP,
  status: proto.ReleaseStatus.RELEASE_STATUS_RELEASED,
  releaseDate,
  localizations: [],
  languages: [ENGLISH],
});

export const STUB_BASE_GAME: proto.GameData = {
  externalId: 'stub-1001',
  title: 'Stub Island',
  contentType: proto.ContentType.CONTENT_TYPE_BASE_GAME,
  description: 'Settle a small island, one tile at a time.',
  yearPublished: 2020,
  designers: [{ externalId: 'stub-person-1', name: 'Ada Stub' }],
  artists: [{ externalId: 'stub-person-2', name: 'Grace Fixture' }],
  publishers: [{ externalId: 'stub-publisher-1', name: 'Stub Games' }],
  mechanics: [{ externalId: 'stub-mechanic-1', name: 'Tile Placement' }],
  categories: [{ externalId: 'stub-category-1', name: 'Exploration' }],
  families: [],
  averageRating: 7.5,
  ratingsCount: 42,
  minPlayers: 2,
  maxPlayers: 4,
  minPlaytime: 30,
  maxPlaytime: 60,
  minAge: 10,
  platforms: [TABLETOP],
  releases: [defaultRelease('2020-01-01')],
  themes: [],
  ageRatings: [],
  metadataKeys: [],
  metadataValues: [],
  dlc: [],
};

export const STUB_EXPANSION: proto.GameData = {
  externalId: 'stub-1002',
  title: 'Stub Island: Harbours',
  contentType: proto.ContentType.CONTENT_TYPE_EXPANSION,
  description: 'Adds harbours, and ships to sail between them.',
  yearPublished: 2021,
  designers: [{ externalId: 'stub-person-1', name: 'Ada Stub' }],
  artists: [],
  publishers: [{ externalId: 'stub-publisher-1', name: 'Stub Games' }],
  mechanics: [{ externalId: 'stub-mechanic-1', name: 'Tile Placement' }],
  categories: [{ externalId: 'stub-category-1', name: 'Exploration' }],
  families: [],
  minPlayers: 2,
  maxPlayers: 5,
  minPlaytime: 45,
  maxPlaytime: 75,
  minAge: 10,
  baseGameExternalId: 'stub-1001',
  platforms: [TABLETOP],
  releases: [defaultRelease('2021-01-01')],
  themes: [],
  ageRatings: [],
  metadataKeys: [],
  metadataValues: [],
  dlc: [],
};

/** Every game, in the order a search returns them. */
export const STUB_GAMES: readonly proto.GameData[] = [STUB_BASE_GAME, STUB_EXPANSION];

export const STUB_LANGUAGES: proto.GatewayLanguageEntry[] = [
  {
    value: 'en-US',
    format: proto.LanguageCodeFormat.LANGUAGE_CODE_FORMAT_IETF_BCP_47,
    ietfTag: 'en-US',
    iso6391: 'en',
    iso6393: 'eng',
    name: 'English',
    nativeName: 'English',
  },
];
