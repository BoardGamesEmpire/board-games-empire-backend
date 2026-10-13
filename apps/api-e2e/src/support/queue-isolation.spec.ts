import { E2E_OWNS_REDIS_VAR, E2E_REDIS_FLUSH_OK_VAR } from './e2e-env';
import { hasDrainToRun, openIsolatedQueue, registerDrain, requireNoLeftoverJobs } from './queue-isolation';

/**
 * The refusal half of `isolateQueue`, reached through the function its
 * `beforeAll` calls. None of these environments names a Redis host, so a guard
 * that let the call through would fail differently: on the missing
 * `REDIS_BULLMQ_*` connection details rather than on the ownership check. The
 * message is therefore what proves the guard ran first, before any connection
 * existed to obliterate with.
 */
describe('openIsolatedQueue', () => {
  it('refuses a Redis the harness published as not its own', () => {
    expect(() => openIsolatedQueue('feedback-delivery', { [E2E_OWNS_REDIS_VAR]: 'false' })).toThrow(
      /Refusing to obliterate the 'feedback-delivery' queue.*BGE_E2E_REDIS_FLUSH_OK=true/s,
    );
  });

  it('refuses when globalSetup never published ownership at all', () => {
    expect(() => openIsolatedQueue('feedback-delivery', {})).toThrow(/Refusing to obliterate/);
  });

  it('lets an owned server through to the connection', () => {
    expect(() => openIsolatedQueue('feedback-delivery', { [E2E_OWNS_REDIS_VAR]: 'true' })).toThrow(/REDIS_BULLMQ_HOST/);
  });

  it('lets an acknowledged escape-hatch server through to the connection', () => {
    expect(() => openIsolatedQueue('feedback-delivery', { [E2E_REDIS_FLUSH_OK_VAR]: 'true' })).toThrow(
      /REDIS_BULLMQ_HOST/,
    );
  });
});

/**
 * The verdict half of `checkLeftoverJobs` (#684). Its hooks can only be seen
 * to catch a leak by a spec file that fails, so the suite carries none;
 * `harness/queue-check.spec.ts` covers the case that passes, a file that
 * drains the queue at its top level.
 */
describe('requireNoLeftoverJobs', () => {
  it('passes a file that finished with as many pending jobs as it started with', () => {
    expect(() => requireNoLeftoverJobs('feedback-delivery', 2, 2)).not.toThrow();
  });

  it('passes a file that finished with fewer, having cleared leftovers from an earlier file', () => {
    expect(() => requireNoLeftoverJobs('feedback-delivery', 3, 0)).not.toThrow();
  });

  it('fails a file that left jobs behind, naming the queue, the count and the fix', () => {
    expect(() => requireNoLeftoverJobs('feedback-delivery', 1, 3)).toThrow(
      /left 2 job\(s\) pending on the 'feedback-delivery' queue \(1 when it started, 3 when it finished\).*isolateQueue\('feedback-delivery'\)/s,
    );
  });
});

/**
 * When `checkLeftoverJobs` leaves a queue to the file's own drain (#684): only
 * while a drain registered for it is still to run. The queue names are this
 * spec's own, so the registry it shares with this file's own check is left as
 * it was found.
 */
describe('registerDrain', () => {
  it('leaves the queue to the file while its drain is still to run', () => {
    const drainRan = registerDrain('drain-pending');

    expect(hasDrainToRun('drain-pending')).toBe(true);
    drainRan();
  });

  it('hands the queue back once the drain has run, so a job left after it counts', () => {
    registerDrain('drain-finished')();

    expect(hasDrainToRun('drain-finished')).toBe(false);
  });

  it('waits for every drain registered for the queue', () => {
    const first = registerDrain('drain-twice');
    const second = registerDrain('drain-twice');

    first();
    expect(hasDrainToRun('drain-twice')).toBe(true);

    second();
    expect(hasDrainToRun('drain-twice')).toBe(false);
  });

  it('covers every queue one drain empties', () => {
    const drainRan = registerDrain('drain-first-queue', 'drain-second-queue');

    expect([hasDrainToRun('drain-first-queue'), hasDrainToRun('drain-second-queue')]).toEqual([true, true]);

    drainRan();
    expect([hasDrainToRun('drain-first-queue'), hasDrainToRun('drain-second-queue')]).toEqual([false, false]);
  });

  it('leaves a queue with no drain registered to the check', () => {
    expect(hasDrainToRun('drain-never-registered')).toBe(false);
  });
});
