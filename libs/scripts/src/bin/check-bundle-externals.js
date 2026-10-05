#!/usr/bin/env node
'use strict';
/**
 * Entrypoint for the bundle-externals check that the image build runs, after
 * its production-only install (#593). Pass the built bundles to check:
 *
 *   node check-bundle-externals.js apps/api/dist/main.js apps/worker/dist/main.js
 *
 * Deliberately thin: the check lives in `bundle-externals/check.js`, where it is
 * unit-testable. This file only reports and sets the exit code.
 */
const path = require('node:path');

const { checkBundleExternals } = require('../bundle-externals/check');

const bundles = process.argv.slice(2).map((bundle) => path.resolve(bundle));

try {
  if (bundles.length === 0) throw new Error('name the bundles to check');

  const { externals, missing, withoutExternals } = checkBundleExternals(bundles);

  for (const bundle of withoutExternals) {
    console.error(
      `bundle-externals: found no externals in ${path.relative(process.cwd(), bundle)}, so it cannot be checked; has the bundle's format changed?`,
    );
  }
  for (const { bundle, specifier } of missing) {
    console.error(
      `bundle-externals: ${path.relative(process.cwd(), bundle)} requires "${specifier}", which does not resolve`,
    );
  }
  if (missing.length > 0) {
    console.error(
      'bundle-externals: a package the code imports at runtime must be a production dependency; see libs/scripts/src/bundle-externals/check.js',
    );
  }

  if (missing.length === 0 && withoutExternals.length === 0) {
    console.log(`bundle-externals: all ${externals} externals of ${bundles.length} bundle(s) resolve`);
  } else {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(`bundle-externals: ${error.message}`);
  process.exitCode = 1;
}
