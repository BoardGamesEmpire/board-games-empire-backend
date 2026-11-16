import type { HouseholdPlugin, Prisma } from '@bge/database';
import { buildPluginManifest, type PluginManifestValidationResult } from '@boardgamesempire/plugin-manifest';
import { PluginConfigSchemaUnusableError } from '../config/config-schema.errors';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { activeManifestOf } from '../manifest/active-manifest';
import { assertHeldConfigSatisfiesGate } from './household-config-gate';
import { PluginUnitConfigRequiredError } from './unit.errors';

describe('household config gate', () => {
  const plugin = { slug: 'demo-sink', version: '1.2.0' };
  /** Fails ajv's meta-schema, so it cannot compile. */
  const unusableSchema = { type: 'no-such-type' };
  const requiringSchema = {
    type: 'object',
    properties: { webhookUrl: { type: 'string' } },
    required: ['webhookUrl'],
  };

  const makeHouseholdRow = (overrides: Partial<HouseholdPlugin> = {}): HouseholdPlugin => ({
    id: 'hp-1',
    householdId: 'hh-1',
    pluginId: 'plugin-1',
    enabled: false,
    config: {},
    dormantReason: null,
    dormantAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  let configSchema: PluginConfigSchemaService;

  beforeEach(() => {
    configSchema = new PluginConfigSchemaService();
  });

  const gate =
    (
      existing: HouseholdPlugin | null,
      activeConfig: { schema?: Record<string, unknown>; requiresHouseholdConfig?: boolean } = {},
    ) =>
    () =>
      assertHeldConfigSatisfiesGate(
        configSchema,
        plugin,
        {
          schema: activeConfig.schema ?? requiringSchema,
          requiresHouseholdConfig: activeConfig.requiresHouseholdConfig ?? false,
        },
        existing,
      );

  const violations = (keyword: string) =>
    expect.objectContaining({
      constructor: PluginUnitConfigRequiredError,
      pluginSlug: 'demo-sink',
      issues: expect.arrayContaining([expect.objectContaining({ keyword })]),
    });

  it('refuses a first switch-on with no document when the manifest requires one (#323)', () => {
    const requiring = gate(null, { schema: {}, requiresHouseholdConfig: true });

    expect(requiring).toThrow(expect.objectContaining({ constructor: PluginUnitConfigRequiredError, issues: [] }));
  });

  it('refuses a first switch-on when {} fails the schema, whether or not the manifest requires configuration (#1151)', () => {
    // The unit would hold `{}`, which the read calls needs_configuration, so
    // switching it on would put it straight into a state it cannot serve in.
    expect(gate(null, { requiresHouseholdConfig: false })).toThrow(violations('required'));
    expect(gate(null, { requiresHouseholdConfig: true })).toThrow(PluginUnitConfigRequiredError);
  });

  it('accepts a first switch-on with no document when {} conforms and none is required (#1151)', () => {
    expect(gate(null, { schema: { type: 'object', properties: { webhookUrl: { type: 'string' } } } })).not.toThrow();
    expect(gate(null, { schema: {} })).not.toThrow();
  });

  it('refuses a retained document the schema rejects, with or without the flag (#1151)', () => {
    const retained = makeHouseholdRow({ config: { webhookUrl: 42 } });

    expect(gate(retained, { requiresHouseholdConfig: false })).toThrow(violations('type'));
    expect(gate(retained, { requiresHouseholdConfig: true })).toThrow(violations('type'));
    expect(gate(makeHouseholdRow({ config: {} }))).toThrow(violations('required'));
  });

  it('refuses a retained document that is not an object, however permissive the schema (#369, #1151)', () => {
    const notAnObject = (config: unknown) => makeHouseholdRow({ config: config as Prisma.JsonValue });

    for (const config of [[], null, 'text', 7]) {
      expect(gate(notAnObject(config), { schema: {} })).toThrow(
        expect.objectContaining({
          constructor: PluginUnitConfigRequiredError,
          issues: [
            expect.objectContaining({ keyword: 'type', message: 'retained configuration is not a JSON object' }),
          ],
        }),
      );
    }
  });

  it('accepts a retained document that conforms (#369)', () => {
    const retained = makeHouseholdRow({ config: { webhookUrl: 'https://retained.test' } });

    expect(gate(retained)).not.toThrow();
    expect(gate(retained, { requiresHouseholdConfig: true })).not.toThrow();
  });

  it('refuses a first switch-on under a schema that cannot be used as unusable, not as needing configuration (#1151)', () => {
    // The read calls the unit `unavailable`, which outranks
    // needs_configuration, and no document the admin supplies would cure it.
    const switchOn = gate(null, { schema: unusableSchema, requiresHouseholdConfig: true });

    expect(switchOn).toThrow(PluginConfigSchemaUnusableError);
    expect(switchOn).not.toThrow(PluginUnitConfigRequiredError);
  });

  /**
   * The read works a household unit's dormancy out from the document it holds
   * through `judgeConfig`; this gate decides whether a switch-on may leave the
   * unit holding that document. If the two disagreed about one document, a
   * switch-on could put a unit straight into needs_configuration, or refuse
   * one the read would serve. Run under a permissive schema as well, where a
   * stored JSON `null` is the document a gate reading `null` as `{}` would let
   * through, and under a schema that cannot be used, which the read calls
   * `unavailable` whatever the document is: no configuration cures that, so
   * the gate must never ask for one.
   */
  describe('refuses exactly the documents the rule reads as needs_configuration (#1151)', () => {
    const schemas: readonly [string, Record<string, unknown>][] = [
      ['a schema that requires a field', requiringSchema],
      ['the permissive schema {}', {}],
      ['a schema that cannot be used', unusableSchema],
    ];
    const documents: readonly [string, unknown][] = [
      ['{}', {}],
      ['{ webhookUrl: 42 }', { webhookUrl: 42 }],
      ["{ webhookUrl: 'https://x.test' }", { webhookUrl: 'https://x.test' }],
      ['[]', []],
      ['null', null],
    ];
    const cases = schemas.flatMap(([schemaName, schema]) =>
      documents.map(([documentName, document]) => [schemaName, documentName, schema, document] as const),
    );

    const validatedWith = (schema: Record<string, unknown>): PluginManifestValidationResult => ({
      manifest: buildPluginManifest({
        slug: plugin.slug,
        version: plugin.version,
        scope: 'household',
        config: { schema, requiresHouseholdConfig: false },
      }),
      permissionChecks: [],
      declaredPermissions: [],
      externalPermissionChecks: [],
      warnings: [],
    });

    it.each(cases)('under %s, holding %s', (_schemaName, _documentName, schema, document) => {
      const verdict = activeManifestOf(validatedWith(schema), configSchema).judgeConfig(document);
      const retained = makeHouseholdRow({ enabled: true, config: document as Prisma.JsonValue });
      const switchOn = gate(retained, { schema, requiresHouseholdConfig: false });

      if (schema === unusableSchema) {
        expect(verdict).toBe('schema-unusable');
      }

      if (verdict === 'rejected') {
        expect(switchOn).toThrow(PluginUnitConfigRequiredError);
      } else if (verdict === 'schema-unusable') {
        expect(switchOn).toThrow(PluginConfigSchemaUnusableError);
        expect(switchOn).not.toThrow(PluginUnitConfigRequiredError);
      } else {
        expect(verdict).toBe('conforms');
        expect(switchOn).not.toThrow();
      }
    });
  });
});
