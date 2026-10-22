import { DataGatewayCapability } from '@bge/database';
import { wrapJobData, type JobMetaEnvelope } from '@bge/queue-actor-context';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import * as crypto from 'node:crypto';
import {
  SECTION_ATTEMPTS,
  SECTION_BACKOFF_MS,
  SECTION_ORDER,
  SECTION_SPACING_MS,
  VOCABULARY_SECTION_JOB,
  VOCABULARY_SECTION_QUEUE,
  type VocabularySectionJob,
} from './constants/vocabulary-section.constants';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Queues a DataGateway's list jobs after its interview stored its answers
 * (#718): one per list it declares and no admin switched off, the rule
 * routing applies, a minute apart, languages first.
 *
 * A job's id is its DataGateway and list, so a job already waiting or
 * running isn't queued twice. The coordinator and the gateway worker both
 * interview, and the second interview's jobs fold into the first's. A list
 * that changes while its job runs loads after the next interview, and
 * imports link its new entries meanwhile.
 */
@Injectable()
export class VocabularySectionQueue {
  private readonly logger = new Logger(VocabularySectionQueue.name);

  constructor(
    @InjectQueue(VOCABULARY_SECTION_QUEUE)
    private readonly queue: Queue<VocabularySectionJob & JobMetaEnvelope>,
  ) {}

  /**
   * Queues the list jobs. Never throws: a job the queue refuses is logged,
   * and its list is loaded after the next interview.
   */
  async enqueue(
    gatewayId: string,
    declared: readonly DataGatewayCapability[],
    disabled: readonly DataGatewayCapability[],
  ): Promise<void> {
    const sections = SECTION_ORDER.filter(
      (capability) => declared.includes(capability) && !disabled.includes(capability),
    );
    // The system's doing, whoever's request reached the DataGateway first.
    const meta = {
      actor: { kind: 'system', reason: 'gateway-registry:vocabulary-section' },
      correlationId: crypto.randomUUID(),
    } as const;

    for (const [position, capability] of sections.entries()) {
      try {
        await this.queue.add(VOCABULARY_SECTION_JOB, wrapJobData({ gatewayId, capability }, meta), {
          jobId: `${gatewayId}-${capability}`,
          delay: position * SECTION_SPACING_MS,
          attempts: SECTION_ATTEMPTS,
          backoff: { type: 'exponential', delay: SECTION_BACKOFF_MS },
          removeOnComplete: true,
          removeOnFail: true,
        });
      } catch (err) {
        this.logger.warn(`Couldn't queue DataGateway ${gatewayId}'s ${capability} section: ${errorMessage(err)}`);
      }
    }
  }
}
