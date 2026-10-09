/**
 * The image smoke suite (#600): one run, in order, against one stack of the
 * images under test. It is the `smoke` target's config, and named so that
 * nothing infers a `test` target from it: a `test` run has no images. It is
 * the unit config, transform and all, apart from what follows.
 */
module.exports = {
  ...require('./jest.config.cts'),
  displayName: '@boardgamesempire/image-smoke:smoke',
  testMatch: ['<rootDir>/src/**/*.smoke.ts'],
  // One stack, so one worker. The suite's steps share it, in order.
  maxWorkers: 1,
  // The stack's boot has a timeout of its own, in the suite.
  testTimeout: 120_000,
};
