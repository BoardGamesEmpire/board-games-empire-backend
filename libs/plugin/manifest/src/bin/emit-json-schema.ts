import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPluginManifestJsonSchemaArtifact } from '../lib/json-schema.js';

/**
 * Writes the plugin-manifest JSON Schema artifact to disk. Invoked by the
 * `emit-json-schema` Nx target after `build`; the artifact content is exactly
 * `renderPluginManifestJsonSchemaArtifact()`, whose parity with the builder
 * output is covered by `json-schema.spec.ts`. CI publication of the emitted
 * file at its `$id` URL is #206.
 *
 * The artifact deliberately lives OUTSIDE `dist/`: `dist` is the inferred
 * `build` target's cached output, so a later cache-hit build would restore
 * `dist` wholesale and silently delete anything the cache never contained. A
 * sibling `dist-schema/` keeps the two targets' outputs disjoint.
 *
 * The default path is resolved relative to THIS compiled file
 * (`<lib>/dist/bin/`), not the process cwd, so the artifact always lands in
 * `<lib>/dist-schema/` no matter where the target is invoked from. An explicit
 * path argument, when given, is resolved relative to cwd.
 */
const binDir = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ARTIFACT_PATH = resolve(binDir, '../../dist-schema/plugin-manifest.v1.json');

const main = (): void => {
  const override = process.argv[2];
  const artifactPath = override ? resolve(process.cwd(), override) : DEFAULT_ARTIFACT_PATH;

  mkdirSync(dirname(artifactPath), { recursive: true });
  writeFileSync(artifactPath, renderPluginManifestJsonSchemaArtifact(), 'utf8');

  process.stdout.write(`plugin-manifest JSON Schema artifact written to ${artifactPath}\n`);
};

main();
