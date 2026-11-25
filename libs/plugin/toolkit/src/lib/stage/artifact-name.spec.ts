import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artifactNameFor, FALLBACK_ARTIFACT_NAME, readArtifactName } from './artifact-name.js';

const manifest = (fields: Record<string, unknown>): string => JSON.stringify({ name: { en: 'Demo' }, ...fields });

describe('artifactNameFor (#1093)', () => {
  it('names the plugin artifact <slug>-<version>', () => {
    expect(artifactNameFor(manifest({ slug: 'demo-sink', version: '1.2.0' }))).toBe('demo-sink-1.2.0');
  });

  it('writes the version as semver does, so validate and build agree on the name', () => {
    expect(artifactNameFor(manifest({ slug: 'demo-sink', version: 'v1.2.0' }))).toBe('demo-sink-1.2.0');
  });

  it.each<[string, string]>([
    ['a slug the server refuses', manifest({ slug: '../evil', version: '1.2.0' })],
    ['a version semver cannot read', manifest({ slug: 'demo-sink', version: '../../up' })],
    ['a slug that is not a string', manifest({ slug: 7, version: '1.2.0' })],
    ['no version', manifest({ slug: 'demo-sink' })],
    ['a plugin manifest that is not an object', '[]'],
    ['a plugin manifest that is not JSON', '{ "slug": '],
  ])('falls back to package for %s, leaving the validator to report it', (_name, text) => {
    expect(artifactNameFor(text)).toBe(FALLBACK_ARTIFACT_NAME);
    expect(FALLBACK_ARTIFACT_NAME).toBe('package');
  });
});

describe('readArtifactName (#1093)', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'bge-artifact-name-spec-'));
  });

  afterAll(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it("reads the name from the folder's manifest.json", async () => {
    const dir = await mkdtemp(join(root, 'plugin-'));
    await writeFile(join(dir, 'manifest.json'), manifest({ slug: 'demo-sink', version: '1.2.0' }));

    await expect(readArtifactName(dir)).resolves.toBe('demo-sink-1.2.0');
  });

  it('falls back to package when the folder has no manifest.json', async () => {
    await expect(readArtifactName(await mkdtemp(join(root, 'empty-')))).resolves.toBe(FALLBACK_ARTIFACT_NAME);
  });
});
