import { OccurrenceStatus } from '@bge/database';
import type { I18nPath } from '@bge/i18n';
import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';

/**
 * One whole sentence per status, so a refusal never splices the enum's name
 * into its message (#1114). Keyed by the whole enum: a new status won't compile
 * until it has a sentence.
 */
const OCCURRENCE_STATE_MESSAGE = {
  [OccurrenceStatus.Proposed]: 'errors.occurrence.state.proposed',
  [OccurrenceStatus.Confirmed]: 'errors.occurrence.state.confirmed',
  [OccurrenceStatus.Declined]: 'errors.occurrence.state.declined',
  [OccurrenceStatus.Cancelled]: 'errors.occurrence.state.cancelled',
} as const satisfies Record<OccurrenceStatus, I18nPath>;

/** 400 for an availability vote on a date that isn't Proposed. `state` carries the date's status (#1114). */
export function occurrenceNotProposed(status: OccurrenceStatus): CodedHttpException {
  return new CodedHttpException(Http.BadRequest, 'OCCURRENCE_NOT_PROPOSED', t(OCCURRENCE_STATE_MESSAGE[status]), {
    fields: { state: status },
  });
}

/**
 * 400 for a confirm, decline or cancel the date's status can't start from.
 * The message says where the date is; `state` and `to` let a client say the
 * rest (#1114).
 */
export function occurrenceTransitionRefused(from: OccurrenceStatus, to: OccurrenceStatus): CodedHttpException {
  return new CodedHttpException(
    Http.BadRequest,
    'OCCURRENCE_TRANSITION_NOT_ALLOWED',
    t(OCCURRENCE_STATE_MESSAGE[from]),
    { fields: { state: from, to } },
  );
}
