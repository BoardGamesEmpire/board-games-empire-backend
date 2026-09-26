import baseConfig, { i18nHardcodedStringSelectors, restrictedImportPaths } from '../../../eslint.config.mjs';

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
  {
    // #145 guardrail — this lib is migrated to i18n (#144), so new hardcoded
    // user-facing strings must fail the build. Specs are exempt: they assert on
    // rendered English copy on purpose.
    //
    // The two gRPC actor interceptors are exempt as whole files. No caller
    // ever reads their refusals: Nest's BaseRpcExceptionFilter answers any
    // non-RpcException with "Internal server error" and only logs the
    // exception. That log line is the one place the text is readable, and a
    // `t()` marker body would reduce it to the class-derived "Bad Request
    // Exception" / "Unauthorized Exception" (#501).
    files: ['**/*.ts'],
    ignores: ['**/*.spec.ts', '**/grpc-internal-actor.interceptor.ts', '**/grpc-actor.interceptor.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...i18nHardcodedStringSelectors],
    },
  },
];
