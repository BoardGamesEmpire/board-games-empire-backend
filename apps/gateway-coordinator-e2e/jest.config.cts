const { readFileSync } = require('fs');

// Reading the SWC compilation config for the spec files
const swcJestConfig = JSON.parse(readFileSync(`${__dirname}/.spec.swcrc`, 'utf-8'));

// Disable .swcrc look-up by SWC core because we're passing in swcJestConfig ourselves
swcJestConfig.swcrc = false;

module.exports = {
  displayName: '@boardgamesempire/gateway-coordinator-e2e',
  preset: '../../jest.preset.js',
  globalSetup: '<rootDir>/src/support/global-setup.ts',
  globalTeardown: '<rootDir>/src/support/global-teardown.ts',
  testEnvironment: 'node',
  // One database for every spec file, and each file launches its own
  // coordinator, which loads every data-gateway plugin the database holds
  // (#1083). So the files run one at a time, and each clears the plugin rows
  // before it seeds its own.
  maxWorkers: 1,
  // Applies to hooks too: a hook may launch the coordinator, or stop it and
  // launch it again.
  testTimeout: 120_000,
  transform: {
    '^.+\\.(t|j|mj)s$': ['@swc/jest', swcJestConfig],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: 'test-output/jest/coverage',
};
