import { DataGatewaySectionFailure } from '@bge/database';
import { ActorAwareWorkerHost, type JobMetaEnvelope } from '@bge/queue-actor-context';
import { guardWorkerEvent } from '@bge/utils';
import type { DataGatewayDriver } from '@boardgamesempire/gateway-driver-contract';
import { OnWorkerEvent, Processor } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { VOCABULARY_SECTION_QUEUE, type VocabularySectionJob } from './constants/vocabulary-section.constants';
import { GatewayRoutingRefusedError } from './errors/gateway-routing-refused.error';
import { VocabularySectionError } from './errors/vocabulary-section.error';
import { GatewayInterviewService } from './gateway-interview.service';
import { GatewayRegistryService } from './gateway-registry.service';
import { VocabularySectionService } from './vocabulary-section.service';

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Runs the list jobs, in the gateway worker only (#718). Each job loads one
 * section through the driver the gateway registry routes its capability to,
 * so a capability switched off or no longer declared, or a DataGateway
 * disabled or deleted since the job was queued, ends the job quietly. The
 * section runs under the interview's abandonment: once the registry lets go
 * of the driver, it writes no further link, and the attempt fails, so the
 * retry asks through the new connection; on the last try it ends quietly.
 *
 * `processJob` makes one attempt and throws on failure, so BullMQ owns the
 * retries; the failure is recorded after the last one. A list the
 * DataGateway doesn't implement is recorded at once instead. Neither path counts
 * toward auto-disable: a section, like the interview, says nothing about
 * whether the DataGateway is down (#712).
 */
@Processor(VOCABULARY_SECTION_QUEUE)
export class VocabularySectionProcessor extends ActorAwareWorkerHost<VocabularySectionJob> {
  private readonly logger = new Logger(VocabularySectionProcessor.name);

  constructor(
    private readonly registry: GatewayRegistryService,
    private readonly interviews: GatewayInterviewService,
    private readonly sections: VocabularySectionService,
  ) {
    super();
  }

  protected async processJob(job: Job<VocabularySectionJob & JobMetaEnvelope>): Promise<void> {
    const { gatewayId, capability } = job.data;

    let driver: DataGatewayDriver;
    try {
      driver = await this.registry.resolve(gatewayId, capability);
    } catch (err) {
      if (err instanceof GatewayRoutingRefusedError) {
        // Nothing to load, and nothing failed (#715, #718).
        this.logger.debug(`Not loading DataGateway ${gatewayId}'s ${capability} section: ${err.message}`);
        return;
      }

      throw err;
    }

    let abandonment: AbortSignal | undefined;
    try {
      await this.interviews.runSection(gatewayId, driver, (signal) => {
        abandonment = signal;
        return this.sections.load(gatewayId, capability, driver, signal);
      });
    } catch (err) {
      // Retrying won't make the DataGateway implement the list.
      if (err instanceof VocabularySectionError && err.code === DataGatewaySectionFailure.ListUnsupported) {
        this.logger.warn(`DataGateway ${gatewayId}'s ${capability} section failed (${err.code}): ${err.message}`);
        await this.sections.recordFailed(gatewayId, capability, err.code, new Date());
        return;
      }

      // A closed connection isn't the section failing, so the last try ends
      // without recording one; the list loads after the next interview.
      if (abandonment?.aborted && job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
        this.logger.debug(`DataGateway ${gatewayId}'s ${capability} section was abandoned on its last try`);
        return;
      }

      throw err;
    }

    await this.sections.recordLoaded(gatewayId, capability, new Date());
    this.logger.log(`Loaded DataGateway ${gatewayId}'s ${capability} section`);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<VocabularySectionJob & JobMetaEnvelope>, error: Error): Promise<void> {
    const { gatewayId, capability } = job.data;
    const attempts = job.opts.attempts ?? 1;

    if (job.attemptsMade < attempts) {
      this.logger.warn(
        `DataGateway ${gatewayId}'s ${capability} section failed, will retry: ` +
          `attemptsMade=${job.attemptsMade} attempts=${attempts} error=${errorMessage(error)}`,
      );
      return;
    }

    const code = error instanceof VocabularySectionError ? error.code : DataGatewaySectionFailure.ListFailed;
    this.logger.warn(`DataGateway ${gatewayId}'s ${capability} section failed (${code}): ${errorMessage(error)}`);

    // Guarded because an unhandled rejection out of this `failed` listener
    // would crash the whole worker.
    await guardWorkerEvent(this.logger, `DataGateway ${gatewayId} ${capability} section failure`, () =>
      this.runInActorScope(job, () => this.sections.recordFailed(gatewayId, capability, code, new Date())),
    );
  }
}
