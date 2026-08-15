import baseConfig, { restrictedImportPaths } from '../../../eslint.config.mjs';

// This lib owns ActorAwareWorkerHost — a sanctioned "worker base" that must
// populate CLS from the job envelope, so it may import
// AuditContextInternalService — and only that name. The internal-CLS entry
// is NARROWED rather than dropped: dropping it would also free the raw CLS
// keys (ABILITIES_CLS_KEY among them), which this lib has no business with.
// Every other repo-wide restriction re-applies unchanged, so any future
// restricted import added to the root config still applies here. Subclasses
// receive the service via the base's property injection and never import it
// themselves, so the exception stays confined to this single lib.
const allowedRestrictedImportPaths = Object.entries(restrictedImportPaths).map(([key, entry]) =>
  key === 'auditContextInternal'
    ? { ...entry, importNames: entry.importNames.filter((name) => name !== 'AuditContextInternalService') }
    : entry,
);

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
