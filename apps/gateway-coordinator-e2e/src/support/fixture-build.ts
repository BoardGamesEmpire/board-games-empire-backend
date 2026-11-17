/**
 * What one build of the fixture plugin is made with (#1083). The fixture
 * reads it from `__FIXTURE_BUILD__`, which `placeFixturePlugin` defines when
 * it bundles the plugin, so a spec states what a build answers with and then
 * asserts that the coordinator relays exactly that. Two builds that differ
 * here are two versions of the plugin.
 */
export interface FixtureBuild {
  /** The version its manifest names, and its driver reports on Ping. */
  readonly version: string;

  /** The one game its search returns and its fetch finds. */
  readonly game: {
    readonly externalId: string;
    readonly title: string;
  };

  /**
   * The batch limit it declares for FetchGames: an interview answer, which
   * tells one build's answers from another's on the DataGateway's row.
   */
  readonly fetchGamesMaxIds: number;

  /**
   * FetchGame of this external ID answers with the actor the plugin's code
   * ran as, as JSON in the answer's `message`.
   */
  readonly actorProbeExternalId: string;
}

/** The build a spec places unless it is telling two builds apart. */
export const FIRST_BUILD: FixtureBuild = {
  version: '1.0.0',
  game: { externalId: 'fixture-game', title: 'Fixture Game, first build' },
  fetchGamesMaxIds: 50,
  actorProbeExternalId: 'who-is-acting',
};
