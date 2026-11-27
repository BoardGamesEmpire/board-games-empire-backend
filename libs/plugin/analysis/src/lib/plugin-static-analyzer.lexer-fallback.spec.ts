import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginCodeRoot } from './plugin-static-analyzer.js';
import { PluginStaticAnalyzer } from './plugin-static-analyzer.js';

/**
 * Isolated from the main analyzer spec on purpose: that suite runs the real
 * parsers, and no input found makes the real es-module-lexer throw on source
 * meriyah accepts. The fallback still has to screen ESM when it does (#59),
 * so here the lexer always throws and meriyah's walk is the only ESM source.
 */
jest.mock('es-module-lexer', () => ({
  init: () => Promise.resolve(),
  parse: () => {
    throw new Error('lexer failed');
  },
}));

describe('PluginStaticAnalyzer when the ESM lexer fails', () => {
  const analyzer = new PluginStaticAnalyzer();
  let rootDir: string;

  const codeRoot = (): PluginCodeRoot => ({
    slug: 'demo-sink',
    rootDir,
    packageJsonPath: join(rootDir, 'package.json'),
  });

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'bge-lexer-fallback-'));
    await writeFile(join(rootDir, 'package.json'), JSON.stringify({ name: 'demo-sink', version: '1.0.0' }), 'utf-8');
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('recovers static imports, re-exports and dynamic imports from the AST (#59)', async () => {
    await writeFile(
      join(rootDir, 'index.mjs'),
      [
        "import 'axios';",
        "export { request } from 'undici';",
        "export * from 'ioredis';",
        'export const local = 1;',
        "export const later = () => import('node:http');",
        'export const loose = (name) => import(name);',
        '',
      ].join('\n'),
      'utf-8',
    );

    const report = await analyzer.analyze(codeRoot(), { deepScan: false });

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'esm-import', specifier: 'axios', severity: 'forbidden' }),
        expect.objectContaining({ kind: 'esm-import', specifier: 'undici', severity: 'forbidden' }),
        expect.objectContaining({ kind: 'esm-import', specifier: 'ioredis', severity: 'forbidden' }),
        expect.objectContaining({ kind: 'dynamic-import', specifier: 'node:http', severity: 'forbidden' }),
        expect.objectContaining({ kind: 'non-literal-import', specifier: null, severity: 'warning' }),
      ]),
    );
    // `export const local` has no source and names nothing.
    expect(report.findings).toHaveLength(5);
  });
});
