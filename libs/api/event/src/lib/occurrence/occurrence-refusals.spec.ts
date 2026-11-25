import { OccurrenceStatus } from '@bge/database';
import type { I18nPath } from '@bge/i18n';
import { t } from '@bge/i18n';
import { Http } from '@status/codes';
import { occurrenceNotProposed, occurrenceTransitionRefused } from './occurrence-refusals';

// Literal on purpose: reading the expected key from the map under test would
// let two swapped entries pass (#1114).
const EXPECTED_KEYS: [OccurrenceStatus, I18nPath][] = [
  [OccurrenceStatus.Proposed, 'errors.occurrence.state.proposed'],
  [OccurrenceStatus.Confirmed, 'errors.occurrence.state.confirmed'],
  [OccurrenceStatus.Declined, 'errors.occurrence.state.declined'],
  [OccurrenceStatus.Cancelled, 'errors.occurrence.state.cancelled'],
];

describe('occurrence refusals (#1114)', () => {
  it('covers every OccurrenceStatus in the table', () => {
    expect(EXPECTED_KEYS.map(([status]) => status).sort()).toEqual(Object.values(OccurrenceStatus).sort());
  });

  it.each(EXPECTED_KEYS)('occurrenceNotProposed(%s) is a 400 with the status as `state`, reading %s', (status, key) => {
    const refusal = occurrenceNotProposed(status);

    expect(refusal.getStatus()).toBe(Http.BadRequest);
    expect(refusal.getResponse()).toMatchObject({
      statusCode: Http.BadRequest,
      code: 'OCCURRENCE_NOT_PROPOSED',
      state: status,
      message: t(key),
    });
  });

  it.each(EXPECTED_KEYS)(
    'occurrenceTransitionRefused(%s, Confirmed) is a 400 saying where the date is and where it was going, reading %s',
    (from, key) => {
      const refusal = occurrenceTransitionRefused(from, OccurrenceStatus.Confirmed);

      expect(refusal.getStatus()).toBe(Http.BadRequest);
      expect(refusal.getResponse()).toMatchObject({
        statusCode: Http.BadRequest,
        code: 'OCCURRENCE_TRANSITION_NOT_ALLOWED',
        state: from,
        to: OccurrenceStatus.Confirmed,
        message: t(key),
      });
    },
  );
});
