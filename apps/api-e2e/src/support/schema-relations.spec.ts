import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { childRelationsOf, defaultModelsRoot } from './schema-relations';

/**
 * The reader that tells the FK-implied-lock audit which tables are in its
 * class, exercised on schemas this repo does not have.
 *
 * Almost every branch in that module is a REFUSAL, and every refusal describes
 * a schema shape the real one does not contain — a composite key, a child with
 * no `@@map`, a parent nothing references. Held against `prisma/models` alone
 * the module has one reachable path, so the guards that make it trustworthy are
 * exactly the parts nothing had ever run. That is not a hypothetical worry: the
 * composite-key guard was verified by editing a shipped model by hand and
 * putting it back.
 *
 * Each case writes a small schema to a temporary directory and asks the reader
 * about it, which is what the `modelsRoot` parameter exists for.
 */
describe('reading FK children out of a Prisma schema', () => {
  const roots: string[] = [];

  afterAll(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /** A throwaway schema directory holding the given files. */
  const schema = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), 'schema-relations-'));

    roots.push(root);

    for (const [name, source] of Object.entries(files)) {
      const target = join(root, name);

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }

    return root;
  };

  const GRANT = `model PluginGrant {
  id String @id

  pluginId String @map("plugin_id")
  plugin   Plugin @relation(fields: [pluginId], references: [id], onDelete: Cascade)

  @@map("plugin_grants")
}`;

  describe('the relation forms Prisma allows', () => {
    it('reads the model, table, accessor, key and column of a plain relation', () => {
      expect(childRelationsOf('Plugin', schema({ 'plugin/grant.prisma': GRANT }))).toEqual([
        {
          model: 'PluginGrant',
          table: 'plugin_grants',
          accessor: 'pluginGrant',
          foreignKey: 'pluginId',
          column: 'plugin_id',
          file: expect.stringContaining('grant.prisma'),
        },
      ]);
    });

    // The regression. A relation NAME may precede the named arguments, and this
    // schema writes more than forty of its relations that way — so a pattern
    // anchored on `@relation(fields:` reads them as no relation at all. The
    // child is then skipped in silence: the empty-result guard below cannot
    // fire while any other child still matches, and the audit runs against a
    // table set short by one.
    it('recognises a positional relation name before the fields', () => {
      const named = GRANT.replace('@relation(fields:', '@relation("PluginOwner", fields:');

      expect(childRelationsOf('Plugin', schema({ 'plugin/grant.prisma': named })).map((child) => child.table)).toEqual([
        'plugin_grants',
      ]);
    });

    it('recognises the name: spelling of the same thing', () => {
      const named = GRANT.replace('@relation(fields:', '@relation(name: "PluginOwner", fields:');

      expect(childRelationsOf('Plugin', schema({ 'plugin/grant.prisma': named })).map((child) => child.table)).toEqual([
        'plugin_grants',
      ]);
    });

    it('reads fields wherever they sit in the argument list', () => {
      const reordered = GRANT.replace(
        '@relation(fields: [pluginId], references: [id], onDelete: Cascade)',
        '@relation(onDelete: Cascade, references: [id], fields: [pluginId])',
      );

      expect(
        childRelationsOf('Plugin', schema({ 'plugin/grant.prisma': reordered })).map((child) => child.foreignKey),
      ).toEqual(['pluginId']);
    });

    // The side holding no key takes no implied lock, so it is passed over
    // rather than refused — and passing it over must not cost the real child
    // beside it.
    it('passes over a back reference, which declares no fields', () => {
      const back = `model PluginConfig {
  id String @id

  plugin Plugin? @relation("PluginConfiguration")

  @@map("plugin_configs")
}`;

      expect(
        childRelationsOf('Plugin', schema({ 'a.prisma': GRANT, 'b.prisma': back })).map((child) => child.table),
      ).toEqual(['plugin_grants']);
    });

    it('falls back to the field name when the scalar carries no @map', () => {
      const unmapped = GRANT.replace('pluginId String @map("plugin_id")', 'pluginId String');

      expect(
        childRelationsOf('Plugin', schema({ 'plugin/grant.prisma': unmapped })).map((child) => child.column),
      ).toEqual(['pluginId']);
    });
  });

  /**
   * The refusals. Each one describes a schema where the honest answer is
   * indistinguishable from a broken reader, and this module's whole value is
   * being the thing that notices — so a short answer would be worse than no
   * check at all.
   */
  describe('what it refuses to answer', () => {
    it('refuses a composite foreign key rather than dropping the child', () => {
      const composite = GRANT.replace('fields: [pluginId]', 'fields: [pluginId, tenantId]');

      expect(() => childRelationsOf('Plugin', schema({ 'a.prisma': composite }))).toThrow(/composite foreign key/);
    });

    // The dangerous version of the same thing: dropped silently, the composite
    // child vanishes while three siblings keep the empty-result guard quiet.
    it('refuses it even when other children still match', () => {
      const composite = GRANT.replace('PluginGrant', 'UserPlugin')
        .replace('plugin_grants', 'user_plugins')
        .replace('fields: [pluginId]', 'fields: [pluginId, userId]');

      expect(() => childRelationsOf('Plugin', schema({ 'a.prisma': GRANT, 'b.prisma': composite }))).toThrow(
        /composite foreign key/,
      );
    });

    it('refuses a child with no @@map, whose table name is stated nowhere', () => {
      const unmapped = GRANT.replace('\n  @@map("plugin_grants")\n', '\n');

      expect(() => childRelationsOf('Plugin', schema({ 'a.prisma': unmapped }))).toThrow(/declares no @@map/);
    });

    it('refuses two relations into the same parent, which key the lock two ways', () => {
      const twice = GRANT.replace(
        '  @@map("plugin_grants")',
        '  supersedesId String @map("supersedes_id")\n' +
          '  supersedes   Plugin @relation("Supersedes", fields: [supersedesId], references: [id])\n\n' +
          '  @@map("plugin_grants")',
      );

      expect(() => childRelationsOf('Plugin', schema({ 'a.prisma': twice }))).toThrow(/cannot say which key/);
    });

    it('refuses a relation keyed on a field the model does not declare', () => {
      const missing = GRANT.replace('  pluginId String @map("plugin_id")\n', '');

      expect(() => childRelationsOf('Plugin', schema({ 'a.prisma': missing }))).toThrow(/declares no\s+scalar field/);
    });

    it('refuses a parent nothing references', () => {
      expect(() => childRelationsOf('Household', schema({ 'a.prisma': GRANT }))).toThrow(/declares an FK/);
    });

    it('refuses a directory with no models in it', () => {
      expect(() => childRelationsOf('Plugin', schema({ 'notes.md': '# nothing here' }))).toThrow(
        /No Prisma models found/,
      );
    });

    // The lift ends at the first `}` in column 0, so a model closing indented
    // swallows its neighbour — and the merged block carries two `@@map`s, of
    // which this reader would take the first, naming one model with another's
    // table.
    it('refuses a model block that appears to contain another model', () => {
      const swallowed = `model PluginConfig {
  id String @id
  @@map("plugin_configs")
  }

${GRANT}`;

      expect(() => childRelationsOf('Plugin', schema({ 'a.prisma': swallowed }))).toThrow(
        /contain another model declaration/,
      );
    });

    it('refuses a parent name that is not a plain model name', () => {
      // It is built into a regex, so `Plugin|User` would read as one model and
      // quietly find the children of both.
      expect(() => childRelationsOf('Plugin|User', schema({ 'a.prisma': GRANT }))).toThrow(/plain Prisma model name/);
    });
  });

  describe('the schema this repo actually ships', () => {
    it('is what the default root reads, unchanged by the parameter existing', () => {
      expect(
        childRelationsOf('Plugin')
          .map((child) => child.table)
          .sort(),
      ).toEqual(
        childRelationsOf('Plugin', defaultModelsRoot())
          .map((child) => child.table)
          .sort(),
      );
    });

    it('maps every plugin child onto the plugin_id column', () => {
      // The raw re-parent shape is built from this, and a shape built from the
      // Prisma spelling would match no SQL in the tree — which passes.
      expect([...new Set(childRelationsOf('Plugin').map((child) => child.column))]).toEqual(['plugin_id']);
    });
  });
});
