import { DatabaseService, InitiatorType, JobStatus, JobType } from '@bge/database';
import type {
  ExpansionFetchJobPayload,
  ExpansionImportJobPayload,
  GameFetchJobPayload,
  GameImportJobPayload,
} from '@bge/game-import';
import { FlowProducerNames, JobNames, QueueNames } from '@bge/game-import';
import { InjectFlowProducer } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { FlowJob, FlowProducer } from 'bullmq';
import * as crypto from 'node:crypto';

@Injectable()
export class GameImportEnqueuerService {
  private readonly logger = new Logger(GameImportEnqueuerService.name);

  constructor(
    private readonly db: DatabaseService,
    @InjectFlowProducer(FlowProducerNames.GamesImport)
    private readonly flowProducer: FlowProducer,
  ) {}

  /**
   * Creates Job rows and enqueues the import flow tree. No gateway calls
   * happen here — the actual fetches run as GameFetch / ExpansionFetch
   * jobs in the gateway-worker, each as a child of the corresponding
   * import job.
   *
   * Flow structure:
   *   GameImport (base) — parent, runs after all children complete
   *   ├── GameFetch (base) — fetches base game data, returns GameData
   *   ├── ExpansionImport (exp 1) — runs after its own fetch child
   *   │   └── ExpansionFetch (exp 1)
   *   └── ExpansionImport (exp 2)
   *       └── ExpansionFetch (exp 2)
   *
   * failParentOnFailure on every fetch child ensures a persistent fetch
   * failure cascades to the import, rather than the import waiting
   * indefinitely.
   */
  async enqueue(input: StartGameImportInput): Promise<EnqueueResult> {
    const batchId = crypto.randomUUID();
    const initiatorType: InitiatorType = input.userId ? InitiatorType.User : InitiatorType.System;

    const { baseJobId, expansionJobIds } = await this.createJobRows(batchId, input, initiatorType);

    const flow = this.buildFlow({
      batchId,
      input,
      baseJobId,
      expansionJobIds,
      initiatorType,
    });

    await this.flowProducer.add(flow);

    this.logger.log(
      `Enqueued import batchId=${batchId}: 1 base + ${expansionJobIds.length} expansion(s) for gateway=${input.gatewayId}`,
    );

    return { batchId, baseJobId, expansionJobIds };
  }

  /**
   * Creates Job rows in a single transaction. One row per game-being-
   * imported (base + each expansion). Status starts Pending; the fetch
   * processor transitions to Running on first attempt.
   */
  private async createJobRows(
    batchId: string,
    input: StartGameImportInput,
    initiatorType: InitiatorType,
  ): Promise<{ baseJobId: string; expansionJobIds: string[] }> {
    return this.db.$transaction(async (tx) => {
      const baseJob = await tx.job.create({
        data: {
          type: JobType.GameImport,
          status: JobStatus.Pending,
          initiatorType,
          userId: input.userId,
          batchId,
          parentJobId: null,
          payload: {
            correlationId: input.correlationId,
            gatewayId: input.gatewayId,
            externalId: input.externalId,
          },
        },
        select: { id: true },
      });

      const expansionJobIds: string[] = [];
      for (const expansionExternalId of input.expansionExternalIds) {
        const expansionJob = await tx.job.create({
          data: {
            type: JobType.GameImport,
            status: JobStatus.Pending,
            initiatorType,
            userId: input.userId,
            batchId,
            parentJobId: baseJob.id,
            payload: {
              correlationId: input.correlationId,
              gatewayId: input.gatewayId,
              externalId: expansionExternalId,
              baseGameExternalId: input.externalId,
            },
          },
          select: { id: true },
        });

        expansionJobIds.push(expansionJob.id);
      }

      return { baseJobId: baseJob.id, expansionJobIds };
    });
  }

  private buildFlow(args: {
    batchId: string;
    input: StartGameImportInput;
    baseJobId: string;
    expansionJobIds: readonly string[];
    initiatorType: InitiatorType;
  }): FlowJob {
    const { batchId, input, baseJobId, expansionJobIds, initiatorType } = args;

    const baseContext = {
      jobId: baseJobId,
      batchId,
      correlationId: input.correlationId,
      gatewayId: input.gatewayId,
      externalId: input.externalId,
      initiatorType,
      userId: input.userId,
    } satisfies GameImportJobPayload;

    const baseFetchPayload: GameFetchJobPayload = { ...baseContext, locale: input.locale };

    const expansionFlows: FlowJob[] = input.expansionExternalIds.map((expansionExternalId, index) => {
      const expansionImportPayload: ExpansionImportJobPayload = {
        jobId: expansionJobIds[index],
        batchId,
        correlationId: input.correlationId,
        gatewayId: input.gatewayId,
        externalId: expansionExternalId,
        baseGameExternalId: input.externalId,
        initiatorType,
        userId: input.userId,
      };

      const expansionFetchPayload: ExpansionFetchJobPayload = {
        ...expansionImportPayload,
        locale: input.locale,
      };

      return {
        name: JobNames.ExpansionImport,
        queueName: QueueNames.GamesImport,
        data: expansionImportPayload,
        opts: { failParentOnFailure: true },
        children: [
          {
            name: JobNames.ExpansionFetch,
            queueName: QueueNames.GatewayFetch,
            data: expansionFetchPayload,
            opts: { failParentOnFailure: true },
          },
        ],
      } satisfies FlowJob;
    });

    return {
      name: JobNames.GameImport,
      queueName: QueueNames.GamesImport,
      data: baseContext,
      children: [
        {
          name: JobNames.GameFetch,
          queueName: QueueNames.GatewayFetch,
          data: baseFetchPayload,
          opts: { failParentOnFailure: true },
        },
        ...expansionFlows,
      ],
    } satisfies FlowJob;
  }
}

export interface StartGameImportInput {
  correlationId: string;
  gatewayId: string;
  externalId: string;
  expansionExternalIds: readonly string[];
  locale?: string;
  userId: string | null;
}

export interface EnqueueResult {
  batchId: string;
  baseJobId: string;
  expansionJobIds: string[];
}
