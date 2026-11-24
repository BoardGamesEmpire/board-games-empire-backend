import { MediaContributionStatus } from '@bge/database';
import { t } from '@bge/i18n';
import { Http } from '@status/codes';
import {
  contributionExists,
  contributionNotPending,
  contributionNotReclaimable,
  isLiveContributionStatus,
  LIVE_CONTRIBUTION_STATUSES,
} from './media-contribution-refusals';

// Literal on purpose: reading the expected key from the map under test would
// let two swapped entries pass (#1114).
const EXISTS_KEYS = [
  [MediaContributionStatus.Pending, 'errors.contribution.exists.pending'],
  [MediaContributionStatus.Approved, 'errors.contribution.exists.approved'],
] as const;

const STATE_KEYS = [
  [MediaContributionStatus.Pending, 'errors.contribution.state.pending'],
  [MediaContributionStatus.Approved, 'errors.contribution.state.approved'],
  [MediaContributionStatus.Rejected, 'errors.contribution.state.rejected'],
  [MediaContributionStatus.Reclaimed, 'errors.contribution.state.reclaimed'],
] as const;

// The status names a state the message describes in whole sentences, so no
// enum name reaches the copy (#1114): the key picks the sentence and `status`
// rides as a field for a client to branch on.
describe('media contribution refusals', () => {
  it('covers every status each refusal can carry in the tables (#1114)', () => {
    expect(STATE_KEYS.map(([status]) => status).sort()).toEqual(Object.values(MediaContributionStatus).sort());
    expect(EXISTS_KEYS.map(([status]) => status).sort()).toEqual([...LIVE_CONTRIBUTION_STATUSES].sort());
  });

  describe('contributionExists', () => {
    it.each(EXISTS_KEYS)('answers 409 MEDIA_CONTRIBUTION_EXISTS for a %s contribution (#1114)', (status, key) => {
      const refusal = contributionExists(status);

      expect(refusal.getStatus()).toBe(Http.Conflict);
      expect(refusal.code).toBe('MEDIA_CONTRIBUTION_EXISTS');
      expect(refusal.getResponse()).toMatchObject({ code: 'MEDIA_CONTRIBUTION_EXISTS', status, message: t(key) });
    });
  });

  describe.each([
    ['contributionNotPending', contributionNotPending, 'MEDIA_CONTRIBUTION_NOT_PENDING'],
    ['contributionNotReclaimable', contributionNotReclaimable, 'MEDIA_CONTRIBUTION_NOT_RECLAIMABLE'],
  ] as const)('%s', (_name, factory, code) => {
    it.each(STATE_KEYS)(`answers 409 ${code} for a %s contribution (#1114)`, (status, key) => {
      const refusal = factory(status);

      expect(refusal.getStatus()).toBe(Http.Conflict);
      expect(refusal.code).toBe(code);
      expect(refusal.getResponse()).toMatchObject({ code, status, message: t(key) });
    });
  });

  it.each([
    [MediaContributionStatus.Pending, true],
    [MediaContributionStatus.Approved, true],
    [MediaContributionStatus.Rejected, false],
    [MediaContributionStatus.Reclaimed, false],
  ] as const)('tells whether %s is a live contribution status: %s (#1114)', (status, live) => {
    expect(isLiveContributionStatus(status)).toBe(live);
  });
});
