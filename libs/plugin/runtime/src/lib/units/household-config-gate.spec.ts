import { PluginUnitDormantReason, type HouseholdPlugin, type Prisma } from '@bge/database';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { assertRetainedConfigSatisfiesGate, configDormancyCleared } from './household-config-gate';
import { PluginUnitConfigRequiredError } from './unit.errors';

describe('household config gate', () => {
  const plugin = { slug: 'demo-sink', version: '1.2.0' };
  const schema = { type: 'object', properties: { webhookUrl: { type: 'string' } }, required: ['webhookUrl'] };

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
    (existing: HouseholdPlugin | null, against: Record<string, unknown> = schema) =>
    () =>
      assertRetainedConfigSatisfiesGate(configSchema, plugin, against, existing);

  describe('assertRetainedConfigSatisfiesGate', () => {
    it('refuses a household with no unit enablement, so no retained document, with no issues to name (#323)', () => {
      expect(gate(null)).toThrow(PluginUnitConfigRequiredError);
      expect(gate(null)).toThrow(expect.objectContaining({ pluginSlug: 'demo-sink', issues: [] }));
    });

    /**
     * The `config` column is Json, so its type admits arrays, `null` and
     * scalars, and a permissive schema accepts every one of them.
     * Reconciliation calls such a document nonconforming; this gate must
     * agree, or the pass that made the unit dormant and the write that returns
     * it to service would disagree about what a valid retained document is
     * (#369).
     */
    it('refuses a retained document that is not a JSON object, however permissive the schema (#369)', () => {
      const notAnObject = makeHouseholdRow({ config: [] as unknown as Prisma.JsonValue });

      expect(gate(notAnObject, {})).toThrow(
        expect.objectContaining({
          constructor: PluginUnitConfigRequiredError,
          issues: [expect.objectContaining({ keyword: 'type' })],
        }),
      );
    });

    it('refuses a retained document the active schema rejects, naming its violations (#369)', () => {
      expect(gate(makeHouseholdRow({ config: {} }))).toThrow(
        expect.objectContaining({
          constructor: PluginUnitConfigRequiredError,
          issues: [expect.objectContaining({ keyword: 'required' })],
        }),
      );
    });

    it('passes a retained document that conforms to the active schema (#369)', () => {
      expect(gate(makeHouseholdRow({ config: { webhookUrl: 'https://retained' } }))).not.toThrow();
    });
  });

  describe('configDormancyCleared', () => {
    it('clears a dormancy for configuration: the document that caused it has just been judged conforming (#370)', () => {
      const dormant = makeHouseholdRow({
        dormantReason: PluginUnitDormantReason.NeedsConfiguration,
        dormantAt: new Date(0),
      });

      expect(configDormancyCleared(dormant)).toEqual({ dormantReason: null, dormantAt: null });
    });

    it('leaves a unit dormant for any other reason, and an ordinary unit, untouched (#370)', () => {
      const orphaned = makeHouseholdRow({
        dormantReason: PluginUnitDormantReason.ScopeOrphaned,
        dormantAt: new Date(0),
      });

      expect(configDormancyCleared(orphaned)).toEqual({});
      expect(configDormancyCleared(makeHouseholdRow())).toEqual({});
    });
  });
});
