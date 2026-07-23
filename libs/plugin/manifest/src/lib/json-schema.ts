import { z } from 'zod';
import { PLUGIN_MANIFEST_JSON_SCHEMA_ID } from './constants.js';
import { pluginManifestSchema } from './manifest.schema.js';

/**
 * JSON Schema artifact for `manifest.json` (D-C).
 *
 * Uses zod v4's native `z.toJSONSchema` instead of the `zod-to-json-schema`
 * package the amendment named — one dependency fewer and first-party
 * maintained. Because `manifest.schema.ts` is refinement-free by contract,
 * this export is a LOSSLESS projection of the structural rules; the semantic
 * pass is documented as intentionally out-of-band for schema consumers.
 * Published for plugin authors and embedded by `bge-plugin validate` (#84).
 */
export const buildPluginManifestJsonSchema = (): Record<string, unknown> => {
  const schema = z.toJSONSchema(pluginManifestSchema, { target: 'draft-2020-12' });

  return {
    ...schema,
    $id: PLUGIN_MANIFEST_JSON_SCHEMA_ID,
    title: 'BGE Plugin Manifest',
    description:
      'Structural schema for a Board Games Empire plugin manifest. Semantic rules ' +
      '(permission namespacing, bgeCompat satisfaction, locale defaults, reason quality) ' +
      'are enforced server-side and by bge-plugin validate, not expressible in JSON Schema.',
  };
};
