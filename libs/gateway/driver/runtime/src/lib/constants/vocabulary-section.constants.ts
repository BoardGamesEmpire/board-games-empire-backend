import { DataGatewayCapability } from '@bge/database';

/**
 * The queue of list jobs (#718). Each loads one section of a DataGateway's
 * vocabulary after its interview. The interview queues them in the
 * coordinator and the gateway worker; only the gateway worker runs them.
 */
export const VOCABULARY_SECTION_QUEUE = '{bge.gateway.vocabulary}';

export const VOCABULARY_SECTION_JOB = 'vocabulary.section';

/** The lists a DataGateway may declare, in the order their jobs run. */
export const SECTION_ORDER: readonly DataGatewayCapability[] = [
  DataGatewayCapability.ListLanguages,
  DataGatewayCapability.ListPlatforms,
  DataGatewayCapability.ListCategories,
  DataGatewayCapability.ListMechanics,
];

/**
 * How far apart a DataGateway's list jobs are queued to start, so its
 * upstream isn't asked for every list at once. It sets the earliest start
 * only: jobs that wait out their delays, as behind a backlog, may run back
 * to back. Only the jobs queued count: a list switched off leaves no gap.
 */
export const SECTION_SPACING_MS = 60 * 1000;

/**
 * How long a list job waits for the DataGateway to answer before the try
 * fails. The gateway worker runs one list job at a time, so a DataGateway
 * that never answers would otherwise hold up every other's lists. A
 * placeholder until #722 sets the deadlines on DataGateway calls; a healthy
 * DataGateway answers in seconds.
 */
export const SECTION_LIST_TIMEOUT_MS = 2 * 60 * 1000;

/** Tries in all, before a section's failure is recorded. */
export const SECTION_ATTEMPTS = 3;

/** The first retry's wait, doubled for the next: 1 minute, then 2. */
export const SECTION_BACKOFF_MS = 60 * 1000;

export interface VocabularySectionJob {
  gatewayId: string;
  capability: DataGatewayCapability;
}
