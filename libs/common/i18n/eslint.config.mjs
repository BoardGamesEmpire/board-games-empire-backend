import baseConfig, { restrictedImportPaths } from '../../../eslint.config.mjs';

// `ClsLocaleResolver` must read the raw `LOCALE_CLS_KEY`: nestjs-i18n
// instantiates resolver classes inside its own (global) module context, where
// only globally-registered providers are injectable — the read-only
// `AuditContextService` is not visible there, only `ClsService` is. Re-apply
// the repo-wide restriction with just that one key carved out, so this lib
// still cannot import the internal populator or the actor/correlation keys.
const narrowedRestrictedImportPaths = Object.entries(restrictedImportPaths).map(([key, path]) =>
  key === 'auditContextInternal'
    ? { ...path, importNames: path.importNames.filter((name) => name !== 'LOCALE_CLS_KEY') }
    : path,
);

export default [
  ...baseConfig,
  {
    ignores: ['**/out-tsc'],
  },
  {
    files: ['**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: narrowedRestrictedImportPaths }],
    },
  },
];
