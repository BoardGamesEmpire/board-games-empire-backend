import baseConfig, { restrictedImportPaths } from '../../../eslint.config.mjs';

// This lib is the legitimate consumer of the internal CLS populator/keys: its
// entry-point interceptors must populate CLS. Re-apply every repo-wide
// restriction EXCEPT that one entry, rather than disabling the rule wholesale —
// so any future restricted import added to the root config still applies here.
const allowedRestrictedImportPaths = Object.entries(restrictedImportPaths)
  .filter(([key]) => key !== 'auditContextInternal')
  .map(([, path]) => path);

export default [
  ...baseConfig,
  {
    ignores: ['**/out-tsc'],
  },
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: allowedRestrictedImportPaths }],
    },
  },
];
