import { PLUGIN_CATEGORIES, PLUGIN_MANIFEST_JSON_SCHEMA_ID, PLUGIN_SLUG_PATTERN } from './constants.js';
import { buildPluginManifestJsonSchema, renderPluginManifestJsonSchemaArtifact } from './json-schema.js';

interface JsonSchemaObjectShape {
  readonly $id?: string;
  readonly $schema?: string;
  readonly type?: string;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Record<string, { readonly pattern?: string; readonly enum?: readonly string[] }>;
}

describe('buildPluginManifestJsonSchema', () => {
  const schema = buildPluginManifestJsonSchema() as JsonSchemaObjectShape;

  it('stamps the published $id and 2020-12 dialect', () => {
    expect(schema.$id).toBe(PLUGIN_MANIFEST_JSON_SCHEMA_ID);
    expect(schema.$schema).toContain('2020-12');
  });

  it('is a strict object schema with the manifest required keys', () => {
    expect(schema.type).toBe('object');
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(
      expect.arrayContaining([
        'slug',
        'version',
        'bgeCompat',
        'category',
        'scope',
        'permissions',
        'metadataSchemaVersion',
      ]),
    );
  });

  it('preserves structural rules in the artifact (no refinement loss): slug pattern and category enum survive', () => {
    expect(schema.properties?.['slug']?.pattern).toBe(PLUGIN_SLUG_PATTERN.source);
    expect(schema.properties?.['category']?.enum).toEqual([...PLUGIN_CATEGORIES]);
  });
});

describe('renderPluginManifestJsonSchemaArtifact (D-L parity)', () => {
  it('round-trips to exactly the builder output — the emitted file IS the builder result', () => {
    expect(JSON.parse(renderPluginManifestJsonSchemaArtifact())).toEqual(buildPluginManifestJsonSchema());
  });

  it('is deterministic across calls with a stable serialization shape (2-space indent, trailing newline)', () => {
    const first = renderPluginManifestJsonSchemaArtifact();
    const second = renderPluginManifestJsonSchemaArtifact();

    expect(first).toBe(second);
    expect(first.startsWith('{\n  "')).toBe(true);
    expect(first.endsWith('}\n')).toBe(true);
  });
});
