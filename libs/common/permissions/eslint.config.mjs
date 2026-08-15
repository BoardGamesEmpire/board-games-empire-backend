import baseConfig, { i18nHardcodedStringSelectors, restrictedImportPaths } from '../../../eslint.config.mjs';

// AbilityContextInternalService IS the sanctioned primer for the abilities
// CLS slot, so this ONE file may import ABILITIES_CLS_KEY — and only that
// name. The internal-CLS entry is NARROWED rather than dropped: dropping it
// would also free AuditContextInternalService and the other raw CLS keys
// for this file. Every other repo-wide restriction re-applies unchanged,
// scoped to the single file rather than the lib — the rest of this lib
// stays fully restricted.
const allowedRestrictedImportPaths = Object.entries(restrictedImportPaths).map(([key, entry]) =>
  key === 'auditContextInternal'
    ? { ...entry, importNames: entry.importNames.filter((name) => name !== 'ABILITIES_CLS_KEY') }
    : entry,
);

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
