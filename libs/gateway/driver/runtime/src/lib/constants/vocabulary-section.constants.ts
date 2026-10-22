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
 * How far apart a DataGateway's list jobs run, so its upstream isn't asked
 * for every list at once. Only the jobs queued count: a list switched off
 * leaves no gap.
 */
export const SECTION_SPACING_MS = 60 * 1000;

/** Tries in all, before a section's failure is recorded. */
export const SECTION_ATTEMPTS = 3;

/** The first retry's wait, doubled for the next: 1 minute, then 2. */
export const SECTION_BACKOFF_MS = 60 * 1000;

export interface VocabularySectionJob {
  gatewayId: string;
  capability: DataGatewayCapability;
}
