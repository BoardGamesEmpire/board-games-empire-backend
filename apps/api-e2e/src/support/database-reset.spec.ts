import {
  missingPreservedTables,
  PRESERVED_MAY_BE_EMPTY_TABLE_NAMES,
  PRESERVED_TABLE_NAMES,
  quoteQualifiedTable,
  tablesToAssertPopulated,
  tablesToTruncate,
  type TableRef,
} from './database-reset';

describe('database-reset (pure logic)', () => {
  const table = (schemaname: string, tablename: string): TableRef => ({ schemaname, tablename });

  describe('PRESERVED_TABLE_NAMES', () => {
    it('keeps the migration ledger and every seeded table out of the sweep', () => {
      expect(PRESERVED_TABLE_NAMES).toEqual(
        expect.arrayContaining([
          '_prisma_migrations',
          'game_lengths',
          'languages',
          'language_tags',
          'permissions',
          'platforms',
          'roles',
          'role_permissions',
          'safe_http_policy',
          'system_settings',
        ]),
      );
    });
  });

  describe('PRESERVED_MAY_BE_EMPTY_TABLE_NAMES', () => {
    it('keeps the data-migration ledger out of the sweep without requiring it to hold a row', () => {
      expect(PRESERVED_MAY_BE_EMPTY_TABLE_NAMES).toEqual(['data_migrations']);
      expect(PRESERVED_TABLE_NAMES).not.toContain('data_migrations');
    });
  });

  describe('tablesToTruncate', () => {
    it('leaves the data-migration ledger alone by default, as it does the schema ledger', () => {
      const all: TableRef[] = [
        table('public', 'data_migrations'),
        table('public', '_prisma_migrations'),
        table('public', 'users'),
      ];

      expect(tablesToTruncate(all)).toEqual([table('public', 'users')]);
    });

    it('filters preserved tables and keeps everything else', () => {
      const all: TableRef[] = [
        table('public', 'users'),
        table('public', 'roles'),
        table('public', 'households'),
        table('public', '_prisma_migrations'),
      ];

      expect(tablesToTruncate(all)).toEqual([table('public', 'users'), table('public', 'households')]);
    });

    it('returns an empty list when only preserved tables exist', () => {
      const all: TableRef[] = [table('public', 'roles'), table('public', 'permissions')];

      expect(tablesToTruncate(all)).toEqual([]);
    });

    it('matches on table name regardless of schema', () => {
      const all: TableRef[] = [table('board_games_empire', 'roles'), table('board_games_empire', 'sessions')];

      expect(tablesToTruncate(all)).toEqual([table('board_games_empire', 'sessions')]);
    });

    it('honors a caller-supplied preserved set', () => {
      const all: TableRef[] = [table('public', 'users'), table('public', 'keep_me')];

      expect(tablesToTruncate(all, new Set(['keep_me']))).toEqual([table('public', 'users')]);
    });
  });

  describe('missingPreservedTables', () => {
    it('returns empty when every preserved name exists, the may-be-empty ones included', () => {
      const all = [...PRESERVED_TABLE_NAMES, ...PRESERVED_MAY_BE_EMPTY_TABLE_NAMES].map((name) =>
        table('public', name),
      );

      expect(missingPreservedTables(all)).toEqual([]);
    });

    it('names a stale may-be-empty entry too: preserved by name, it drifts the same way', () => {
      const all = PRESERVED_TABLE_NAMES.map((name) => table('public', name));

      expect(missingPreservedTables(all)).toEqual(['data_migrations']);
    });

    it('names preserved entries absent from the schema — the stale-list signal', () => {
      // A rename in the schema strands the old name here while the REAL
      // table stops matching the preserve list and gets truncated; the
      // stranded name is the only detectable symptom.
      const all = [table('public', 'roles'), table('public', 'users')];

      expect(missingPreservedTables(all, ['roles', 'system_settings'])).toEqual(['system_settings']);
    });
  });

  describe('tablesToAssertPopulated', () => {
    it('checks the seeded tables and the schema ledger for rows, not the data-migration ledger, which may be empty', () => {
      const all: TableRef[] = [
        table('public', 'roles'),
        table('public', '_prisma_migrations'),
        table('public', 'data_migrations'),
        table('public', 'users'),
      ];

      expect(tablesToAssertPopulated(all)).toEqual([table('public', 'roles'), table('public', '_prisma_migrations')]);
    });
  });

  describe('quoteQualifiedTable', () => {
    it('quotes schema and table', () => {
      expect(quoteQualifiedTable(table('public', 'game_lengths'))).toBe('"public"."game_lengths"');
    });

    it('refuses identifiers that could break out of quoting', () => {
      expect(() => quoteQualifiedTable(table('public', 'users"; DROP TABLE roles; --'))).toThrow(/unsafe identifier/);
      expect(() => quoteQualifiedTable(table('pub"lic', 'users'))).toThrow(/unsafe identifier/);
      expect(() => quoteQualifiedTable(table('public', 'users table'))).toThrow(/unsafe identifier/);
    });
  });
});
