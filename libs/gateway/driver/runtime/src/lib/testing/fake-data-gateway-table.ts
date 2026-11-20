import type { DataGateway } from '@bge/database';
import { AuthType } from '@bge/database';
import type { RoutedPlugin } from '../plugin-driver-source';

type Where = Readonly<Record<string, unknown>>;

/**
 * A select names a scalar with `true`, and a relation with its own select,
 * which the fake doesn't narrow by. An include names relations the same way.
 */
interface Query {
  include?: Readonly<Record<string, boolean | object>>;
  select?: Readonly<Record<string, boolean | object>>;
  where?: Where;
}

/** A stored row, with the plugin a read may select beside it: null for a remote DataGateway. */
type StoredRow = DataGateway & { plugin: RoutedPlugin | null };

interface Update {
  data: Readonly<Record<string, unknown>>;
  where: Where;
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
        if (!Array.isArray(operand)) {
          throw new TypeError(`The fake data_gateways table's 'in' filter takes an array`);
        }

        return operand.some((candidate) => sameValue(actual, candidate));
      case 'not':
        return !sameValue(actual, operand);
      default:
        throw new Error(`The fake data_gateways table doesn't support the '${operator}' filter`);
    }
  });
};

/** A field a query names, which may be no column at all: then undefined, as reading it off the row gives. */
const fieldOf = (row: StoredRow, field: string): unknown => {
  const fields: Readonly<Record<string, unknown>> = row;
  return fields[field];
};

const matches = (row: StoredRow, where: Where = {}): boolean =>
  Object.entries(where).every(([field, condition]) => matchesField(fieldOf(row, field), condition));

/**
 * Without a select, the row's own columns, as Prisma answers: a relation
 * comes only when selected, or included beside the columns.
 */
const project = (row: StoredRow, { select, include }: Pick<Query, 'select' | 'include'>): Partial<StoredRow> => {
  if (select) {
    return Object.fromEntries(Object.keys(select).map((field) => [field, fieldOf(row, field)]));
  }

  const { plugin, ...columns } = row;
  return include?.plugin ? { ...columns, plugin } : columns;
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
    findUnique: async (query: Query) => this.findAll(query)[0] ?? null,
    findFirst: async (query: Query = {}) => this.findAll(query)[0] ?? null,
    findMany: async (query: Query = {}) => this.findAll(query),

    updateMany: async ({ where, data }: Update) => {
      const rows = this.matching(where);
      rows.forEach((row) => this.apply(row, data));
      return { count: rows.length };
    },
  };

  private matching(where?: Where): StoredRow[] {
    return [...this.rows.values()].filter((row) => matches(row, where));
  }

  private findAll({ where, ...shape }: Query): Partial<StoredRow>[] {
    return this.matching(where).map((row) => project(row, shape));
  }

  private apply(row: StoredRow, data: Update['data']): StoredRow {
    Object.assign(row, data, { updatedAt: new Date() });
    return row;
  }
}
