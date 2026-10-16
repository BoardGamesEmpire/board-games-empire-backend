import { AuthType, type DataGateway } from '@bge/database';

type Where = Readonly<Record<string, unknown>>;

interface Query {
  where?: Where;
  select?: Readonly<Record<string, boolean>>;
}

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

const matches = (row: DataGateway, where: Where = {}): boolean =>
  Object.entries(where).every(([field, condition]) => matchesField(row[field as keyof DataGateway], condition));

const project = (row: DataGateway, select?: Query['select']): Partial<DataGateway> =>
  select
    ? Object.fromEntries(Object.keys(select).map((field) => [field, row[field as keyof DataGateway]]))
    : { ...row };

/**
 * An in-memory `data_gateways` table behind the slice of Prisma's delegate
 * that the gateway registry and the interview call, so specs can seed rows
 * and read back what was stored. It understands only the filters those
 * callers use, and throws on any other, so a new query fails loudly here
 * rather than passing against a filter the fake silently ignores.
 */
export class FakeDataGatewayTable {
  private readonly rows = new Map<string, DataGateway>();

  /** Adds a row: enabled, never interviewed, with no answers, unless overridden. */
  seed(overrides: Partial<DataGateway> & Pick<DataGateway, 'id'>): DataGateway {
    const now = new Date();
    const row: DataGateway = {
      name: overrides.id,
      description: null,
      messageContext: null,
      iconUrl: null,
      logoUrl: null,
      websiteUrl: null,
      apiBaseUrl: null,
      apiDocumentation: null,
      apiVersion: null,
      connectionUrl: 'localhost',
      connectionPort: 50051,
      enabled: true,
      authType: AuthType.None,
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
    };

    this.rows.set(row.id, row);
    return row;
  }

  /** The stored row, as a copy. */
  row(id: string): DataGateway | undefined {
    const row = this.rows.get(id);
    return row && { ...row };
  }

  /** Changes a row outside any delegate call, as another process would. */
  patch(id: string, changes: Partial<DataGateway>): void {
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

    update: async ({ where, data }: Update) => {
      const [row] = this.matching(where);
      if (!row) {
        throw new Error('Record to update not found.');
      }

      return { ...this.apply(row, data) };
    },

    updateMany: async ({ where, data }: Update) => {
      const rows = this.matching(where);
      rows.forEach((row) => this.apply(row, data));
      return { count: rows.length };
    },
  };

  private matching(where?: Where): DataGateway[] {
    return [...this.rows.values()].filter((row) => matches(row, where));
  }

  private findAll(where?: Where, select?: Query['select']): Partial<DataGateway>[] {
    return this.matching(where).map((row) => project(row, select));
  }

  private apply(row: DataGateway, data: Update['data']): DataGateway {
    Object.assign(row, data, { updatedAt: new Date() });
    return row;
  }
}
