import { AuthType, type DataGateway, type Plugin } from '@bge/database';

type Where = Readonly<Record<string, unknown>>;

/** A select names a scalar with `true`, and a relation with its own select, which the fake doesn't narrow by. */
interface Query {
  where?: Where;
  select?: Readonly<Record<string, boolean | object>>;
}

/** What a routing decision reads of the plugin behind a plugin DataGateway's row (#1083). */
type SeededPlugin = Pick<Plugin, 'id' | 'slug' | 'enabled' | 'uninstalledAt' | 'loadFailed' | 'installedAt'>;

/** A stored row, with the plugin a read may select beside it: null for a remote DataGateway. */
type StoredRow = DataGateway & { plugin: SeededPlugin | null };

interface Update {
  where: Where;
  data: Readonly<Record<string, unknown>>;
}

const isOperator = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);

const sameValue = (left: unknown, right: unknown): boolean => {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]));
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }

  return left === right;
};

const matchesField = (actual: unknown, condition: unknown): boolean => {
  if (!isOperator(condition)) {
    return sameValue(actual, condition);
  }

  return Object.entries(condition).every(([operator, operand]) => {
    switch (operator) {
      case 'equals':
        return sameValue(actual, operand);
      case 'in':
        return (operand as unknown[]).some((candidate) => sameValue(actual, candidate));
      default:
        throw new Error(`The fake data_gateways table doesn't support the '${operator}' filter`);
    }
  });
};

const matches = (row: StoredRow, where: Where = {}): boolean =>
  Object.entries(where).every(([field, condition]) => matchesField(row[field as keyof StoredRow], condition));

/** Without a select, the row's own columns, as Prisma answers: a relation comes only when selected. */
const project = (row: StoredRow, select?: Query['select']): Partial<StoredRow> => {
  if (select) {
    return Object.fromEntries(Object.keys(select).map((field) => [field, row[field as keyof StoredRow]]));
  }

  const columns: Partial<StoredRow> = { ...row };
  delete columns.plugin;
  return columns;
};

/**
 * An in-memory `data_gateways` table behind the slice of Prisma's delegate
 * that the gateway registry and the interview call, so specs can seed rows
 * and read back what was stored. It understands only the filters those
 * callers use, and throws on any other, so a new query fails loudly here
 * rather than passing against a filter the fake silently ignores.
 */
export class FakeDataGatewayTable {
  private readonly rows = new Map<string, StoredRow>();

  /**
   * Adds a row: a remote DataGateway's, enabled, never interviewed, with no
   * answers, unless overridden. A plugin DataGateway's row passes its
   * `plugin`, and takes the plugin's id and no connection fields (#1083).
   */
  seed(overrides: Partial<StoredRow> & Pick<DataGateway, 'id'>): DataGateway {
    const now = new Date();
    const plugin = overrides.plugin ?? null;
    const row: StoredRow = {
      name: overrides.id,
      description: null,
      messageContext: null,
      iconUrl: null,
      logoUrl: null,
      websiteUrl: null,
      apiBaseUrl: null,
      apiDocumentation: null,
      apiVersion: null,
      pluginId: plugin?.id ?? null,
      connectionUrl: plugin ? null : 'localhost',
      connectionPort: plugin ? null : 50051,
      enabled: true,
      authType: plugin ? null : AuthType.None,
      authParameters: null,
      usageCount: 0,
      lastUsed: null,
      capabilities: [],
      coveragePlatformTypes: [],
      coverageContentTypes: [],
      filterableAxes: [],
      acceptedLanguageCodeFormats: [],
      responseLanguageCodeFormat: null,
      passthroughSearchLanguage: null,
      contentFormat: null,
      gatewayVersion: null,
      upstream: null,
      fetchGamesMaxIds: null,
      disabledCapabilities: [],
      firstInterviewedAt: null,
      lastInterviewedAt: null,
      lastInterviewFailedAt: null,
      lastInterviewFailure: null,
      createdById: null,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
      plugin,
    };

    this.rows.set(row.id, row);
    return row;
  }

  /** The stored row, as a copy. */
  row(id: string): DataGateway | undefined {
    const row = this.rows.get(id);
    return row && { ...row };
  }

  /**
   * Changes a row outside any delegate call, as another process would. A
   * change to `plugin` replaces what the row's plugin reads as, the way an
   * admin's write to the plugin's own row would.
   */
  patch(id: string, changes: Partial<StoredRow>): void {
    const row = this.rows.get(id);
    if (!row) {
      throw new Error(`No data_gateways row ${id} to patch`);
    }

    Object.assign(row, changes);
  }

  readonly delegate = {
    findUnique: async ({ where, select }: Query) => this.findAll(where, select)[0] ?? null,
    findFirst: async ({ where, select }: Query = {}) => this.findAll(where, select)[0] ?? null,
    findMany: async ({ where, select }: Query = {}) => this.findAll(where, select),

    updateMany: async ({ where, data }: Update) => {
      const rows = this.matching(where);
      rows.forEach((row) => this.apply(row, data));
      return { count: rows.length };
    },
  };

  private matching(where?: Where): StoredRow[] {
    return [...this.rows.values()].filter((row) => matches(row, where));
  }

  private findAll(where?: Where, select?: Query['select']): Partial<StoredRow>[] {
    return this.matching(where).map((row) => project(row, select));
  }

  private apply(row: StoredRow, data: Update['data']): StoredRow {
    Object.assign(row, data, { updatedAt: new Date() });
    return row;
  }
}
