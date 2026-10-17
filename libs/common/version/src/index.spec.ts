import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BGE_VERSION } from './index';

/** The root package.json, whose version is the product's. */
const rootManifest = join(__dirname, '..', '..', '..', '..', 'package.json');

describe('BGE_VERSION', () => {
  it("is the root package.json's version, stamped at build time", () => {
    const { version } = JSON.parse(readFileSync(rootManifest, 'utf8')) as { version: string };

    expect(BGE_VERSION).toBe(version);
  });
});
