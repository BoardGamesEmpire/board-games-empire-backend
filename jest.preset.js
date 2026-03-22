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
  '@thallesp/nestjs-better-auth',
  '@better-auth',
  '@noble',
  'apicalypse',
  'axios',
  'better-auth',
  'better-call',
  'jose',
  "rou3"
];

const esmPattern = ESM_PACKAGES.join('|');

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
};
