import baseConfig, { i18nHardcodedStringSelectors, restrictedImportPaths } from '../../../eslint.config.mjs';

// AbilityContextInternalService IS the sanctioned primer for the abilities
// CLS slot, so this ONE file may import ABILITIES_CLS_KEY. Re-apply every
// repo-wide restriction except the internal-CLS entry (the queue
// actor-context precedent), scoped to the single file rather than the lib —
// the rest of this lib stays fully restricted.
const allowedRestrictedImportPaths = Object.entries(restrictedImportPaths)
  .filter(([key]) => key !== 'auditContextInternal')
  .map(([, path]) => path);

export default [
  ...baseConfig,
  {
    ignores: ['**/out-tsc'],
  },
  {
    files: ['**/src/lib/services/ability-context-internal.service.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: allowedRestrictedImportPaths }],
    },
  },
  {
    // #145 guardrail — this lib is migrated to i18n (#144), so new hardcoded
    // user-facing strings must fail the build. Specs are exempt: they assert on
    // rendered English copy on purpose.
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...i18nHardcodedStringSelectors],
    },
  },
];
