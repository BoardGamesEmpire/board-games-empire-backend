/**
 * BoardGameGeek XML API 2 thing types (used as `type` parameter on the
 * search and thing endpoints, and as `type` on returned items).
 *
 * @see https://boardgamegeek.com/wiki/page/BGG_XML_API2
 */
export enum BggThingType {
  BoardGame = 'boardgame',
  BoardGameExpansion = 'boardgameexpansion',
  BoardGameAccessory = 'boardgameaccessory',
  VideoGame = 'videogame',
  RpgItem = 'rpgitem',
  RpgIssue = 'rpgissue',
}

/**
 * BGG link `type` values embedded inside thing responses.
 *
 * Links carry the relational data — categories, mechanics, families,
 * designers, artists, publishers, and inter-game references (expansions,
 * implementations, integrations, compilations). Every link points at
 * another BGG thing by id.
 */
export enum BggLinkType {
  BoardGameCategory = 'boardgamecategory',
  BoardGameMechanic = 'boardgamemechanic',
  BoardGameFamily = 'boardgamefamily',
  BoardGameExpansion = 'boardgameexpansion',
  BoardGameImplementation = 'boardgameimplementation',
  BoardGameIntegration = 'boardgameintegration',
  BoardGameCompilation = 'boardgamecompilation',
  BoardGameDesigner = 'boardgamedesigner',
  BoardGameArtist = 'boardgameartist',
  BoardGamePublisher = 'boardgamepublisher',
}

/**
 * BGG `name` types. A thing typically has one primary and zero or more
 * alternate names (translations / regional editions).
 */
export enum BggNameType {
  Primary = 'primary',
  Alternate = 'alternate',
}

/**
 * Default `type` filter used on search queries — restricts results to
 * board-game-domain items, excluding RPGs, video games, and accessories
 * which BGE does not import via this gateway.
 */
export const DEFAULT_BGG_SEARCH_TYPES: readonly BggThingType[] = [
  BggThingType.BoardGame,
  BggThingType.BoardGameExpansion,
] as const;

/**
 * Default page-size for search and expansion-batch queries. BGG does not
 * paginate search results server-side, but limiting client-side keeps
 * payloads manageable.
 */
export const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Maximum thing IDs per batched thing.query call. BGG accepts large ID
 * lists but throttles aggressively; 20 is a safe per-call ceiling.
 */
export const MAX_THINGS_PER_BATCH = 20;
