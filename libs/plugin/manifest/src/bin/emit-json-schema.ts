import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { renderPluginManifestJsonSchemaArtifact } from '../lib/json-schema.js';

/**
 * Writes the plugin-manifest JSON Schema artifact to disk. Invoked by
 * the `emit-json-schema` Nx target after `build`; the artifact content is
 * exactly `renderPluginManifestJsonSchemaArtifact()`, whose parity with the
 * builder output is covered by `json-schema.spec.ts`. CI publication of the
 * emitted file at its `$id` URL is #206.
 *
 * The artifact deliberately lives OUTSIDE `dist/`: `dist` is the inferred
 * `build` target's cached output, so a later cache-hit build would restore
 * `dist` wholesale and silently delete anything the cache never contained.
 * A sibling `dist-schema/` keeps the two targets' outputs disjoint.
 */
const DEFAULT_ARTIFACT_PATH = 'libs/plugin/manifest/dist-schema/plugin-manifest.v1.json';

const main = (): void => {
  const requestedPath = process.argv[2] ?? DEFAULT_ARTIFACT_PATH;
  const artifactPath = resolve(process.cwd(), requestedPath);

  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, renderPluginManifestJsonSchemaArtifact(), 'utf8');

  process.stdout.write(`plugin-manifest JSON Schema artifact written to ${artifactPath}\n`);
};

main();
