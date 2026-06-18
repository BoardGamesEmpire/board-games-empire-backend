import baseConfig, { restrictedImportPaths } from '../../../eslint.config.mjs';

// This lib owns ActorAwareWorkerHost — a sanctioned "worker base" that must
// populate CLS from the job envelope. Re-apply every repo-wide restriction
// EXCEPT the internal-CLS-populator entry, rather than disabling the rule
// wholesale, so any future restricted import added to the root config still
// applies here. Subclasses receive AuditContextInternalService via the base's
// property injection and never import it themselves, so the exception stays
// confined to this single lib.
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
