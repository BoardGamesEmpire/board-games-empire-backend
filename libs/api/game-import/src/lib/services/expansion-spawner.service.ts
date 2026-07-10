import { DatabaseService, InitiatorType, JobStatus, JobType, Prisma } from '@bge/database';
import type { JobActorMeta } from '@bge/queue-actor-context';
import { InjectFlowProducer } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { FlowProducer } from 'bullmq';
import { FlowProducerNames } from '../constants/queue.constants';
import { buildExpansionFlow } from '../flows/import-flow.builder';
import type { ExpansionImportJobPayload } from '../interfaces/import-job.interface';
import { idempotencyKeyFor } from '../utils/idempotency-key';

export interface SpawnExpansionsInput {
  /** The base Job row id — becomes each expansion row's parentJobId. */
  baseJobId: string;
  batchId: string;
  correlationId: string;
  gatewayId: string;
  /** External id of the base game — recorded on each expansion for the upsert lookup. */
  baseExternalId: string;
  expansionExternalIds: string[];
  locale?: string;
  initiatorType: InitiatorType;
  userId: string | null;
}

/**
 * Creates and enqueues the expansion flows for a base game, once the base
 * source exists. Runs in apps/worker (a *producer* to the fetch queue — it
 * never consumes fetch jobs, so the worker still never calls a gateway).
 *
 * Idempotent by construction, so a base-import retry re-runs it harmlessly:
 *   1. rows are upserted on a per-expansion `idempotencyKey`
 *      (`batchId:exp:externalId`) — a prior attempt's row is returned
 *      untouched (`update: {}`) rather than duplicated;
 *   2. only rows still Pending are (re-)enqueued — completed expansions from a
 *      prior attempt are skipped;
 *   3. each flow's jobId is pinned to its Job row id, so a re-add of a
 *      still-queued job de-dupes at BullMQ.
 */
@Injectable()
export class ExpansionSpawnerService {
  private readonly logger = new Logger(ExpansionSpawnerService.name);

  constructor(
    private readonly db: DatabaseService,
    @InjectFlowProducer(FlowProducerNames.GamesImport)
    private readonly flowProducer: FlowProducer,
  ) {}

  async spawn(input: SpawnExpansionsInput, meta: JobActorMeta): Promise<void> {
    const { baseJobId, batchId } = input;
    // Dedupe: a repeated externalId would otherwise upsert the same row twice (a
    // no-op update) and then enqueue two flows sharing one jobId.
    const externalIds = [...new Set(input.expansionExternalIds)];
    if (externalIds.length === 0) {
      return;
    }

    // Upsert one row per expansion, keyed on a batch+role-namespaced
    // idempotencyKey, atomically. A base-import retry re-runs this harmlessly:
    // an existing row is returned untouched (`update: {}`), so ids stay stable
    // and no duplicate rows appear. The 'exp' namespace keeps an expansion whose
    // externalId equals the base's from colliding onto the base row.
    // `$transaction` preserves order, so rows[i] pairs with externalIds[i].
    const rows = await this.db.$transaction(
      externalIds.map((externalId) => {
        const key = idempotencyKeyFor(batchId, 'exp', externalId);
        return this.db.job.upsert({
          where: { idempotencyKey: key },
          create: {
            type: JobType.GameImport,
            status: JobStatus.Pending,
            initiatorType: input.initiatorType,
            userId: input.userId,
            batchId,
            parentJobId: baseJobId,
            idempotencyKey: key,
            payload: {
              correlationId: input.correlationId,
              gatewayId: input.gatewayId,
              externalId,
              baseGameExternalId: input.baseExternalId,
            } satisfies Prisma.InputJsonObject,
          },
          update: {},
          select: { id: true, status: true },
        });
      }),
    );

    // Enqueue a flow only for rows still Pending: on a retry, expansions already
    // Running/Completed/Failed from a prior attempt are left as-is (a still-queued
    // job's jobId de-dupes the re-add; a terminal one must not be resurrected).
    const flows = rows
      .map((row, index) => ({ row, externalId: externalIds[index] }))
      .filter(({ row }) => row.status === JobStatus.Pending)
      .map(({ row, externalId }) =>
        buildExpansionFlow(
          {
            jobId: row.id,
            batchId,
            correlationId: input.correlationId,
            gatewayId: input.gatewayId,
            externalId,
            baseGameExternalId: input.baseExternalId,
            initiatorType: input.initiatorType,
            userId: input.userId,
            locale: input.locale,
          } satisfies ExpansionImportJobPayload,
          meta,
        ),
      );

    if (flows.length === 0) {
      return;
    }

    await this.flowProducer.addBulk(flows);

    this.logger.log(`Spawned ${flows.length} expansion flow(s) for baseJobId=${baseJobId} batchId=${batchId}`);
  }
}
