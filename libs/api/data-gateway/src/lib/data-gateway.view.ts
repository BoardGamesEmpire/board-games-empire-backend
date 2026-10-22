import type { DataGateway, DataGatewayInterviewFailure } from '@bge/database';

export interface DataGatewayInterviewFailureView {
  code: DataGatewayInterviewFailure;
  at: Date;
}

/** Where a DataGateway's onboarding stands, with the server's rules already applied (#715). */
export interface DataGatewayInterviewStatus {
  /** Whether an interview has ever succeeded. The DataGateway isn't used until one has. */
  interviewed: boolean;
  firstInterviewedAt: Date | null;
  lastInterviewedAt: Date | null;
  /** The last failure, only while it's current. */
  failure: DataGatewayInterviewFailureView | null;
}

/**
 * A DataGateway row as the admin routes return it. The stored credentials are
 * removed, and only whether there are any is said (#753). The raw interview
 * columns stay; `interview` is the block clients read.
 */
export type DataGatewayView = Omit<DataGateway, 'authParameters'> & {
  hasAuthParameters: boolean;
  interview: DataGatewayInterviewStatus;
};

type InterviewColumns = Pick<
  DataGateway,
  'firstInterviewedAt' | 'lastInterviewedAt' | 'lastInterviewFailedAt' | 'lastInterviewFailure'
>;

/**
 * Derives the interview status from the row's columns.
 *
 * A later success leaves the failure columns in place, so a failure is current
 * only while `lastInterviewFailedAt` isn't before `lastInterviewedAt` (#712).
 * A half-written pair reports no failure.
 */
export function interviewStatus(row: InterviewColumns): DataGatewayInterviewStatus {
  const { firstInterviewedAt, lastInterviewedAt, lastInterviewFailedAt, lastInterviewFailure } = row;

  const current =
    lastInterviewFailedAt !== null &&
    lastInterviewFailure !== null &&
    (lastInterviewedAt === null || lastInterviewedAt.getTime() <= lastInterviewFailedAt.getTime());

  return {
    interviewed: firstInterviewedAt !== null,
    firstInterviewedAt,
    lastInterviewedAt,
    failure: current ? { code: lastInterviewFailure, at: lastInterviewFailedAt } : null,
  };
}

/** Shapes a DataGateway row for a response. Every admin route answers through this (#753, #715). */
export function toDataGatewayView(row: DataGateway): DataGatewayView {
  const { authParameters, ...rest } = row;

  return {
    ...rest,
    hasAuthParameters: hasStoredCredentials(authParameters),
    interview: interviewStatus(row),
  };
}

/** `null` and `{}` both mean none: create stores `{}` when no credentials are given. */
function hasStoredCredentials(authParameters: DataGateway['authParameters']): boolean {
  if (authParameters === null || authParameters === undefined) {
    return false;
  }

  if (typeof authParameters === 'object' && !Array.isArray(authParameters)) {
    return Object.keys(authParameters).length > 0;
  }

  return true;
}
