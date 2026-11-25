import { MediaContributionStatus } from '@bge/database';
import type { I18nPath } from '@bge/i18n';
import { CodedHttpException, t } from '@bge/i18n';
import { Http } from '@status/codes';

/**
 * The statuses that hold a piece of media's single contribution slot: a
 * pending one is awaiting review and an approved one is in place. A rejected
 * or reclaimed contribution leaves the slot free (#1114).
 */
export const LIVE_CONTRIBUTION_STATUSES = [MediaContributionStatus.Pending, MediaContributionStatus.Approved] as const;

/** A contribution status that holds the media's contribution slot (#1114). */
export type LiveContributionStatus = (typeof LIVE_CONTRIBUTION_STATUSES)[number];

/** Whether a contribution in this status holds the media's contribution slot (#1114). */
export function isLiveContributionStatus(status: MediaContributionStatus): status is LiveContributionStatus {
  return LIVE_CONTRIBUTION_STATUSES.some((live) => live === status);
}

/**
 * One whole sentence per status, so no enum name is spliced into the message
 * and a locale can word each one itself (#1114).
 */
const CONTRIBUTION_STATE_MESSAGE = {
  [MediaContributionStatus.Pending]: 'errors.contribution.state.pending',
  [MediaContributionStatus.Approved]: 'errors.contribution.state.approved',
  [MediaContributionStatus.Rejected]: 'errors.contribution.state.rejected',
  [MediaContributionStatus.Reclaimed]: 'errors.contribution.state.reclaimed',
} as const satisfies Record<MediaContributionStatus, I18nPath>;

/** Keyed by the live statuses only: those are the ones that block a new contribution (#1114). */
const CONTRIBUTION_EXISTS_MESSAGE = {
  [MediaContributionStatus.Pending]: 'errors.contribution.exists.pending',
  [MediaContributionStatus.Approved]: 'errors.contribution.exists.approved',
} as const satisfies Record<LiveContributionStatus, I18nPath>;

/** The media already holds a live contribution; `state` says which (#1114). */
export function contributionExists(status: LiveContributionStatus): CodedHttpException {
  return new CodedHttpException(Http.Conflict, 'MEDIA_CONTRIBUTION_EXISTS', t(CONTRIBUTION_EXISTS_MESSAGE[status]), {
    fields: { state: status },
  });
}

/** Only a pending contribution can be approved or rejected; `state` is the status it holds (#1114). */
export function contributionNotPending(status: MediaContributionStatus): CodedHttpException {
  return new CodedHttpException(
    Http.Conflict,
    'MEDIA_CONTRIBUTION_NOT_PENDING',
    t(CONTRIBUTION_STATE_MESSAGE[status]),
    { fields: { state: status } },
  );
}

/** Only a rejected contribution can be reclaimed; `state` is the status it holds (#1114). */
export function contributionNotReclaimable(status: MediaContributionStatus): CodedHttpException {
  return new CodedHttpException(
    Http.Conflict,
    'MEDIA_CONTRIBUTION_NOT_RECLAIMABLE',
    t(CONTRIBUTION_STATE_MESSAGE[status]),
    { fields: { state: status } },
  );
}
