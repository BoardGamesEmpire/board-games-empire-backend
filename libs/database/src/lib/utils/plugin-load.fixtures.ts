/**
 * TEST FIXTURES: an in-memory `plugin_process_loads` table that answers the
 * lookup `hasLivePluginLoad` sends (#1083).
 *
 * Reachable only through `@bge/database/testing`, never the main barrel.
 * Beside the reader on purpose, as the Prisma error fixtures are: every spec
 * that asks "is this install loaded?" answers through this one filter, so a
 * change to the lookup's shape fails here, once, instead of passing in specs
 * that each copied the old shape. It knows only `gt` on the heartbeat, so a
 * bound written another way fails rather than passing on the wrong side of
 * the boundary.
 */

/** A load record as far as `hasLivePluginLoad` reads one. */
export interface PluginLoadRecordRow {
  slug: string;
  processRole: string;
  installedAt: Date;
  ready: boolean;
  heartbeatAt: Date;
}

/** The filter `hasLivePluginLoad` sends. */
interface PluginLoadLookupWhere {
  slug: string;
  processRole: string;
  installedAt: Date;
  ready: boolean;
  heartbeatAt: { gt: Date };
}

export interface FakePluginLoadRecords {
  /** The table; a spec sets or replaces it before asking. */
  rows: PluginLoadRecordRow[];

  /** Stands in for `pluginProcessLoad.findFirst`. */
  findFirst(args: { where: PluginLoadLookupWhere }): Promise<{ slug: string } | null>;
}

export function fakePluginLoadRecords(): FakePluginLoadRecords {
  const table: FakePluginLoadRecords = {
    rows: [],
    findFirst: ({ where }) => {
      const match = table.rows.find(
        (row) =>
          row.slug === where.slug &&
          row.processRole === where.processRole &&
          row.installedAt.getTime() === where.installedAt.getTime() &&
          row.ready === where.ready &&
          row.heartbeatAt.getTime() > where.heartbeatAt.gt.getTime(),
      );

      return Promise.resolve(match === undefined ? null : { slug: match.slug });
    },
  };

  return table;
}
