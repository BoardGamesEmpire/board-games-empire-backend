import { SYNC_MAY_WRITE_COPY, SYNC_MAY_WRITE_RATING_CHANGE, syncMayWrite } from './upstream-sync';

/**
 * The one rule every upstream sync obeys (#1231, #1227, #936): a sync never
 * undoes what the user said about a copy or a rating change. The truth table
 * below is the rule; the `where` filters must say the same.
 */
describe('upstream sync filter (#1231)', () => {
  const EDITED = new Date('2026-11-01T00:00:00Z');
  const TAKEN_BACK = new Date('2026-11-02T00:00:00Z');

  it.each([
    ['untouched by the user', { editedByUserAt: null, retractedAt: null }, true],
    ['edited by the user', { editedByUserAt: EDITED, retractedAt: null }, false],
    ['taken back', { editedByUserAt: EDITED, retractedAt: TAKEN_BACK }, false],
    ['taken back with no edit stamp', { editedByUserAt: null, retractedAt: TAKEN_BACK }, false],
  ])('a row %s: a sync may write it = %s', (_, row, mayWrite) => {
    expect(syncMayWrite(row)).toBe(mayWrite);
  });

  it('the copy and rating change filters match only a row neither edited nor taken back', () => {
    expect(SYNC_MAY_WRITE_COPY).toEqual({ editedByUserAt: null, retractedAt: null });
    expect(SYNC_MAY_WRITE_RATING_CHANGE).toEqual({ editedByUserAt: null, retractedAt: null });
  });
});
