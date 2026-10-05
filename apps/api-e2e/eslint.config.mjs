import baseConfig, { restrictedImportPaths } from '../../eslint.config.mjs';

// This spec drives the real Prisma CLI migrator against a sandbox database, so
// it may build one. Only that entry is dropped for it, as for the api's entry
// point; every other repo-wide restriction re-applies to it unchanged.
const migratorAllowedImportPaths = Object.entries(restrictedImportPaths)
  .filter(([key]) => key !== 'prismaCliMigrator')
  .map(([, entry]) => entry);

export default [
  ...baseConfig,
  {
    files: ['src/bootstrap/bootstrap-sequence.spec.ts'],
    rules: {
      'no-restricted-imports': ['error', { paths: migratorAllowedImportPaths }],
    },
  },
];
