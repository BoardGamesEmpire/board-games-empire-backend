const nxPreset = require('@nx/jest/preset').default;

/**
 * Pure-ESM packages that must be transformed by @swc/jest.
 *
 * Rule: add a package here the moment Jest throws
 * "Cannot use import statement outside a module" for it.
 *
 * Keep alphabetically sorted for easy diffing.
 * P.S. - this is fucking stupid
 */
const ESM_PACKAGES = [
  '@better-auth',
  '@paralleldrive',
  '@noble',
  // Scoped to `runtime/` on purpose: the package's entrypoints are CJS and
  // must stay untransformed. Only the WASM query-compiler glue that a real
  // PrismaClient dynamically imports on first query is pure ESM, and it is
  // reached only by suites that talk to an actual database (the e2e harness).
  '@prisma/client/runtime',
  '@thallesp/nestjs-better-auth',
  'apicalypse',
  'axios',
  'better-auth',
  'better-call',
  'iso-639-3',
  'jose',
  'kysely',
  'nanostores',
  'rou3',
];

/**
 * The unified packages behind @bge/content-format (micromark, mdast, hast and
 * their helpers), all pure ESM. There are dozens, so most go by family: each
 * entry is a pattern for a package name. `entities` and `parse5` are listed
 * because hast-util-from-html nests ESM copies of them.
 *
 * Keep alphabetically sorted.
 */
const UNIFIED_ESM_PACKAGES = [
  'ccount',
  'character-entities(-[a-z0-9]+)?',
  'comma-separated-tokens',
  'decode-named-character-reference',
  'devlop',
  'entities',
  'escape-string-regexp',
  'hast-util-[a-z0-9-]+',
  'hastscript',
  'html-void-elements',
  'longest-streak',
  'markdown-table',
  'mdast-util-[a-z0-9-]+',
  'micromark(-[a-z0-9-]+)?',
  'parse5',
  'property-information',
  'rehype-minify-whitespace',
  'space-separated-tokens',
  'stringify-entities',
  'trim-lines',
  'trim-trailing-lines',
  'unist-util-[a-z0-9-]+',
  'vfile(-[a-z0-9-]+)?',
  'web-namespaces',
  'zwitch',
];

const esmPattern = [...ESM_PACKAGES, ...UNIFIED_ESM_PACKAGES].join('|');

module.exports = {
  ...nxPreset,
  /**
   * Extend the transform to cover .mjs files.
   * The default Nx pattern only matches [tj]s — pure-ESM packages that
   * ship .mjs dist files (e.g. @thallesp/nestjs-better-auth) would
   * otherwise bypass @swc/jest entirely, even if allowlisted below.
   *
   * Note: individual jest.config.cts files that declare their own
   * `transform` block override this — they must also include the mjs rule.
   */
  transform: {
    '^.+\\.(t|j|mj)s$': [
      '@swc/jest',
      // swcrc is loaded per-project; the preset provides the pattern only.
      // Projects with a local .spec.swcrc should keep their own transform block
      // and add the mjs entry there instead.
    ],
  },

  /**
   * Jest ignores node_modules by default.
   * This pattern inverts the ignore for the listed packages so
   * @swc/jest can transform them from ESM → CJS at test time.
   *
   * Regex breakdown:
   *   node_modules/(?!(pkg1|pkg2|...)/))
   *   → ignore everything in node_modules EXCEPT the listed packages
   */
  transformIgnorePatterns: [`node_modules/(?!(${esmPattern})/)`],

  /**
   * Load `reflect-metadata` before any test module is evaluated.
   *
   * `@bge/shared`'s barrel re-exports class-validator/class-transformer DTOs,
   * so importing *anything* from `@bge/shared` (e.g. a header constant) eagerly
   * evaluates those decorators, which call `Reflect.getMetadata`. At runtime the
   * Nest app already has reflect-metadata loaded; unit tests do not, so load it
   * here. Projects that declare their own `setupFiles` (e.g. e2e) override this
   * and are responsible for loading it themselves.
   */
  setupFiles: ['reflect-metadata'],

  /**
   * `lcovonly` feeds Codecov; `html` keeps the Nx preset's local report.
   *
   * `projectRoot` is load-bearing: istanbul writes lcov `SF:` paths relative
   * to the process cwd, which Nx sets to the project root — so every project
   * reports `src/index.ts`, `src/lib/...`, and Codecov cannot tell which
   * project a file belongs to. Anchoring at the workspace root (this file's
   * directory) makes the paths repo-relative and unambiguous.
   *
   * The line numbers inside those reports are source lines only while each
   * project's `.spec.swcrc` sets `"sourceMaps": "inline"`. CI enforces that;
   * `libs/scripts/src/spec-swcrc/check.js` explains why (#524).
   */
  coverageReporters: ['html', ['lcovonly', { projectRoot: __dirname }]],
};
