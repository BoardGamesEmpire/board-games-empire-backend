const { readFileSync } = require('fs');

// Reading the SWC compilation config for the spec files
const swcJestConfig = JSON.parse(readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'));

// Disable .swcrc look-up by SWC core because we're passing in swcJestConfig ourselves
swcJestConfig.swcrc = false;

module.exports = {
  displayName: '@boardgamesempire/api-e2e',
  preset: '../../jest.preset.js',
  globalSetup: '<rootDir>/src/support/global-setup.ts',
  globalTeardown: '<rootDir>/src/support/global-teardown.ts',
  setupFiles: ['<rootDir>/src/support/test-setup.ts'],
  // Wires the between-test truncate sweep — the isolation model below is a
  // claim only this hook makes true.
  setupFilesAfterEnv: ['<rootDir>/src/support/test-isolation.ts'],
  testEnvironment: 'node',
  // Isolation model (#255): one database, one worker, truncate sweep between
  // tests. CI goes faster by splitting the files across jobs instead (`--shard`,
  // #684), each with its own containers and API child, so this model holds.
  maxWorkers: 1,
  // With one worker, Jest would run every file inside its main process, which
  // keeps what each file loads: about 47 MB a file, so an 85-file shard ran
  // out of heap near 4 GB on its last file (#1083). A memory limit makes Jest
  // run the files in one worker instead, and replace it, between files, once
  // it holds more than this. Still one worker at a time, so the model holds.
  workerIdleMemoryLimit: '1GB',
  // Applies to hooks too — first requests land while the server JIT-warms
  // against freshly started containers.
  testTimeout: 120_000,
  transform: {
    '^.+\\.(t|j|mj)s$': ['@swc/jest', swcJestConfig],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: 'test-output/jest/coverage',
};
