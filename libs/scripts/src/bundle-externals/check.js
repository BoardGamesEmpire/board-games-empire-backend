'use strict';
/**
 * Checks that the npm packages a built app bundle requires resolve where the
 * bundle runs (#593).
 *
 * The bundles keep their npm dependencies external, and the image installs
 * them with `npm ci --omit=dev`. A package the code imports but the root
 * `package.json` lists under `devDependencies` is then missing, and nothing
 * notices until a role fails to boot: development, CI and the e2e suite all run
 * with every dependency installed. `iso-639-3` was one, until #593.
 *
 * `NxAppWebpackPlugin` emits each external as its own module,
 * `module.exports = require("<specifier>");`, so that line is the list. Each
 * specifier is resolved from the bundle's directory, as `require` resolves it
 * at runtime: an app's own `node_modules` first, then up to the root, through
 * the package's `exports`. A builtin resolves to itself. Every app keeps its
 * npm dependencies external, so a bundle with no such line is one whose format
 * this check no longer reads, and it is reported rather than passed.
 *
 * Only the bundle is read. What its externals load in turn is not followed, so
 * neither are the imports of the four workspace packages the bundles load from
 * their `dist`, nor the modules loaded by name at runtime: the logger's
 * transport targets and the Prisma CLI. Booting each role from the image is
 * what covers those (#600).
 */
const fs = require('node:fs');
const path = require('node:path');

const EXTERNAL = /^module\.exports = require\("([^"]+)"\);$/gm;

/**
 * @param {readonly string[]} bundles absolute paths of built `main.js` files
 * @returns {{
 *   externals: number,
 *   missing: { bundle: string, specifier: string }[],
 *   withoutExternals: string[],
 * }}
 */
function checkBundleExternals(bundles) {
  let externals = 0;
  const missing = [];
  const withoutExternals = [];

  for (const bundle of bundles) {
    const source = fs.readFileSync(bundle, 'utf8');
    const from = path.dirname(bundle);
    let found = 0;

    for (const [, specifier] of source.matchAll(EXTERNAL)) {
      found += 1;
      try {
        require.resolve(specifier, { paths: [from] });
      } catch {
        missing.push({ bundle, specifier });
      }
    }

    if (found === 0) withoutExternals.push(bundle);
    externals += found;
  }

  return { externals, missing, withoutExternals };
}

module.exports = { checkBundleExternals };
