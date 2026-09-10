import { attemptWithin, describeHolder } from './advisory-lock';

// The lock itself needs Postgres and is exercised in apps/api-e2e. What can be
// pinned without a database is how an attempt is cut to the deadline and how a
// holder is named.

describe('the advisory lock', () => {
  describe('attemptWithin', () => {
    it('is the full attempt while more than that is left', () => {
      expect(attemptWithin(5_000, 12_000)).toBe(5_000);
      expect(attemptWithin(5_000, Infinity)).toBe(5_000);
    });

    it('is cut to what is left, in whole milliseconds, which is what lock_timeout accepts', () => {
      expect(attemptWithin(5_000, 300)).toBe(300);
      expect(attemptWithin(5_000, 2.7)).toBe(2);
    });

    it('is never shorter than one millisecond, so a free lock is still taken at or past the deadline', () => {
      expect(attemptWithin(5_000, 0.4)).toBe(1);
      expect(attemptWithin(5_000, 0)).toBe(1);
      expect(attemptWithin(5_000, -1_000)).toBe(1);
    });
  });

  describe('describeHolder', () => {
    it('is undefined when nobody holds the lock', () => {
      expect(describeHolder([])).toBeUndefined();
    });

    it('names a holder by pid, application name and state', () => {
      expect(describeHolder([{ pid: 42, application_name: 'bge-bootstrap:api', state: 'idle' }])).toBe(
        'pid 42 (bge-bootstrap:api, idle)',
      );
    });

    it('falls back for a holder without a name or state, and lists several', () => {
      expect(
        describeHolder([
          { pid: 7, application_name: '', state: null },
          { pid: 9, application_name: 'psql', state: 'active' },
        ]),
      ).toBe('pid 7 (unnamed), pid 9 (psql, active)');
    });
  });
});
