import { PluginGrantScope } from '@bge/database';
import { buildPluginManifest, validatePluginManifest } from '@boardgamesempire/plugin-manifest';
import { PluginConfigSchemaService } from '../config/plugin-config-schema.service';
import { activeManifestOf } from './active-manifest';

describe('activeManifestOf (#1151)', () => {
  let configSchema: PluginConfigSchemaService;

  beforeEach(() => {
    configSchema = new PluginConfigSchemaService();
  });

  const activeManifest = (overrides: Parameters<typeof buildPluginManifest>[0] = {}) =>
    activeManifestOf(
      validatePluginManifest(buildPluginManifest(overrides), { bgeVersion: '1.0.0', defaultLocale: 'en' }),
      configSchema,
    );

  const householdUnder = (schema: Record<string, unknown>) =>
    activeManifest({ scope: 'household', config: { schema } });

  describe('householdSurface', () => {
    it('is true for a household-scope manifest', () => {
      expect(activeManifest({ scope: 'household' }).householdSurface).toBe(true);
    });

    it('is false for a server-scope manifest: no household can hold a unit enablement under it', () => {
      expect(activeManifest({ scope: 'server' }).householdSurface).toBe(false);
    });
  });

  it('lists each requested permission at the decision scope its consent scope maps to', () => {
    const manifest = activeManifest({
      scope: 'household',
      permissions: {
        declares: ['manage:digest'],
        checks: [
          {
            slug: 'manage:digest',
            required: true,
            reason: { en: 'Stores and manages the digest configuration it owns.' },
            consentScope: 'server',
          },
          {
            slug: 'read:game:public',
            required: false,
            reason: { en: 'Reads the public catalog to compose the digest.' },
            consentScope: 'household',
          },
        ],
      },
    });

    expect(manifest.requested).toEqual([
      { slug: 'plugin|demo-sink|manage:digest', scopeType: PluginGrantScope.Server },
      { slug: 'read:game:public', scopeType: PluginGrantScope.Household },
    ]);
  });

  describe('judgeConfig', () => {
    const webhookSchema = {
      type: 'object',
      required: ['webhookUrl'],
      properties: { webhookUrl: { type: 'string' } },
    };

    it('reads a document the schema accepts as conforming', () => {
      expect(householdUnder(webhookSchema).judgeConfig({ webhookUrl: 'https://x.test' })).toBe('conforms');
    });

    it('reads a document the schema rejects as rejected', () => {
      const manifest = householdUnder(webhookSchema);

      expect(manifest.judgeConfig({ webhookUrl: 42 })).toBe('rejected');
      expect(manifest.judgeConfig({})).toBe('rejected');
    });

    it.each([null, [], 'text', 7])('reads a retained %p as rejected, never throwing (#390)', (document) => {
      // The permissive schema accepts anything, so only the shape check can
      // reject these: a household's document is a plain object or nothing.
      expect(householdUnder({}).judgeConfig(document)).toBe('rejected');
    });

    it('reads an empty document under a schema of {} as conforming', () => {
      expect(householdUnder({}).judgeConfig({})).toBe('conforms');
    });

    it.each([
      ['a schema that cannot compile', { type: 'no-such-type' }],
      ['an asynchronous schema', { $async: true }],
    ])('reads %s as schema-unusable', (_label, schema) => {
      expect(householdUnder(schema).judgeConfig({})).toBe('schema-unusable');
    });

    it.each([[[]], [null]])(
      'ranks an unusable schema above a %p document: nothing is learned about the document',
      (document) => {
        expect(householdUnder({ type: 'no-such-type' }).judgeConfig(document)).toBe('schema-unusable');
      },
    );

    it('rethrows an error from the validator that is not about the schema', () => {
      const manifest = householdUnder({});
      jest.spyOn(configSchema, 'validate').mockImplementation(() => {
        throw new TypeError('validator broke');
      });

      expect(() => manifest.judgeConfig({})).toThrow(TypeError);
    });
  });
});
