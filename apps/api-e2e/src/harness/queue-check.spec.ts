import { FEEDBACK_QUEUE_NAME } from '@bge/queue-feedback';
import { hasDrainToRun, isolateQueue } from '../support/queue-isolation';

/**
 * `checkLeftoverJobs` leaves a queue to the file's own drain while that drain
 * is still to run (#684). The file passing is the test: a check that counted
 * this queue anyway would fail it.
 *
 * `isolateQueue` sits at this file's top level, outside the describe, on
 * purpose: its drain then runs after the check's `afterAll`, which the setup
 * file registers first. The describe's `afterAll` adds a job after the last
 * test's per-test obliterate, where a late enqueue lands, so the check finds a
 * job its drain then removes.
 */
const feedbackQueue = isolateQueue(FEEDBACK_QUEUE_NAME);

describe('a late job on a queue the file drains at its top level', () => {
  // Jest runs a file's hooks only around tests. This one confirms the state
  // the check's verdict will read; the verdict itself is the file passing.
  it('has the drain still to run while the tests do', () => {
    expect(hasDrainToRun(FEEDBACK_QUEUE_NAME)).toBe(true);
  });

  afterAll(async () => {
    await feedbackQueue().add('queue-check', {});
  });
});
