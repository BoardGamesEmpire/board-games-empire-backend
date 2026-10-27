import {
  type DataGateway,
  type DataGatewayCapability,
  type DataGatewayInterviewFailure,
  type DataGatewaySection,
  type DataGatewaySectionFailure,
  type Prisma,
} from '@bge/database';
import { SECTION_ORDER } from '@bge/gateway-registry';

/** Every row an admin route returns carries its sections (#718). */
export const WITH_SECTIONS = { sections: true } satisfies Prisma.DataGatewayInclude;

export type DataGatewayWithSections = Prisma.DataGatewayGetPayload<{ include: typeof WITH_SECTIONS }>;

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

/** Where one list job's section stands, with the interview's rule for a current failure applied (#718). */
export interface DataGatewaySectionView {
  capability: DataGatewayCapability;
  lastLoadedAt: Date | null;
  /** The last failure, only while it's current. */
  failure: { code: DataGatewaySectionFailure; at: Date } | null;
}

/**
 * A DataGateway row as the admin routes return it. The stored credentials are
 * removed, and only whether there are any is said (#753). The raw interview
 * columns stay; `interview` is the block clients read, and `sections` holds
 * each list job's outcome in its place (#718).
 */
export type DataGatewayView = Omit<DataGatewayWithSections, 'authParameters' | 'sections'> & {
  hasAuthParameters: boolean;
  interview: DataGatewayInterviewStatus;
  sections: DataGatewaySectionView[];
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

/**
 * Derives a section's status from its row, as the interview's is derived: a
 * later load leaves the failure columns in place, so a failure is current
 * only while `lastFailedAt` isn't before `lastLoadedAt`, or while the section
 * has never loaded (#718). A half-written pair reports no failure.
 */
export function sectionStatus(row: DataGatewaySection): DataGatewaySectionView {
  const { capability, lastLoadedAt, lastFailedAt, lastFailure } = row;

  const current =
    lastFailedAt !== null &&
    lastFailure !== null &&
    (lastLoadedAt === null || lastLoadedAt.getTime() <= lastFailedAt.getTime());

  return {
    capability,
    lastLoadedAt,
    failure: current ? { code: lastFailure, at: lastFailedAt } : null,
  };
}

/** Shapes a DataGateway row for a response. Every admin route answers through this (#753, #715). */
export function toDataGatewayView(row: DataGatewayWithSections): DataGatewayView {
  const { authParameters, ...rest } = row;

  return {
    ...rest,
    hasAuthParameters: hasStoredCredentials(authParameters),
    interview: interviewStatus(row),
    sections: currentSections(row).map(sectionStatus),
  };
}

/**
 * The sections of the lists the DataGateway's jobs load, in the order they
 * run: those it declares and no admin switched off. A list dropped or
 * switched off keeps its row, but no job runs for it, so a failure recorded
 * before would read as current for good (#718).
 */
function currentSections(row: DataGatewayWithSections): DataGatewaySection[] {
  return SECTION_ORDER.filter(
    (capability) => row.capabilities.includes(capability) && !row.disabledCapabilities.includes(capability),
  ).flatMap((capability) => row.sections.filter((section) => section.capability === capability));
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
