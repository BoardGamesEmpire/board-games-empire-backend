/* eslint-disable */
import { readFileSync } from 'fs';

// Reading the SWC compilation config for the spec files
const swcJestConfig = JSON.parse(readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'));

// Disable .swcrc look-up by SWC core because we're passing in swcJestConfig ourselves
swcJestConfig.swcrc = false;

export default {
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
  // tests. Template-database-per-worker is the documented upgrade path (#259).
  maxWorkers: 1,
  // Applies to hooks too — first requests land while the server JIT-warms
  // against freshly started containers.
  testTimeout: 120_000,
  transform: {
    '^.+\\.(t|j|mj)s$': ['@swc/jest', swcJestConfig],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: 'test-output/jest/coverage',
};
