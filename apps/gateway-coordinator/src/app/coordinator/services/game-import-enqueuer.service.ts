import { DatabaseService, InitiatorType, JobStatus, JobType } from '@bge/database';
import type { GameImportJobPayload } from '@bge/game-import';
import { buildBaseFlow, FlowProducerNames, idempotencyKeyFor } from '@bge/game-import';
import type { JobActorMeta } from '@bge/queue-actor-context';
import { InjectFlowProducer } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { FlowProducer } from 'bullmq';
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
   * Creates the base Job row and enqueues the base import flow — the base
   * import job plus its single fetch child:
   *
   *   GameImport (base) — persists the base game, then spawns expansion flows
   *   └── GameFetch (base) — fetches base game data, returns GameData
   *
   * Expansions are deliberately NOT enqueued here. The base import processor
   * spawns one expansion flow per id *after* the base GameSource exists, so an
   * expansion can never run before its base (the ordering bug this fixes). No
   * gateway calls happen here — fetches run in the gateway-worker.
   */
  async enqueue(input: StartGameImportInput): Promise<EnqueueResult> {
    const batchId = crypto.randomUUID();
    const initiatorType: InitiatorType = input.userId ? InitiatorType.User : InitiatorType.System;

    const baseJobId = await this.createBaseJobRow(batchId, input, initiatorType);

    // The coordinator is a gRPC service with no CLS actor of its own — the
    // originating identity arrives as userId. Reconstruct the actor from it so
    // it survives the queue hop into the worker's ActorAwareWorkerHost and, in
    // turn, onto the expansion flows the base processor spawns.
    const meta: JobActorMeta = {
      actor: input.userId ? { kind: 'user', userId: input.userId } : { kind: 'system', reason: 'game-import' },
      correlationId: input.correlationId,
    };

    const basePayload: GameImportJobPayload = {
      jobId: baseJobId,
      batchId,
      correlationId: input.correlationId,
      gatewayId: input.gatewayId,
      externalId: input.externalId,
      initiatorType,
      userId: input.userId,
      expansionExternalIds: [...input.expansionExternalIds],
      locale: input.locale,
    };

    await this.flowProducer.add(buildBaseFlow(basePayload, meta));

    this.logger.log(
      `Enqueued import batchId=${batchId}: base + ${input.expansionExternalIds.length} deferred expansion(s) for gateway=${input.gatewayId}`,
    );

    // expansionJobIds is intentionally empty: expansion Job rows are created by
    // the base processor once the base persists, and are discovered via
    // GET /games/import/:batchId rather than returned at enqueue time.
    return { batchId, baseJobId, expansionJobIds: [] };
  }

  /**
   * Creates the base Job row. Status starts Pending; the fetch processor
   * transitions it to Running on first attempt. The `expansionExternalIds`
   * snapshot lets the status endpoint render the full requested graph (including
   * expansions not yet spawned) and gives the base processor its spawn list.
   */
  private async createBaseJobRow(
    batchId: string,
    input: StartGameImportInput,
    initiatorType: InitiatorType,
  ): Promise<string> {
    const baseJob = await this.db.job.create({
      data: {
        type: JobType.GameImport,
        status: JobStatus.Pending,
        initiatorType,
        userId: input.userId,
        batchId,
        parentJobId: null,
        idempotencyKey: idempotencyKeyFor(batchId, 'base', input.externalId),
        payload: {
          correlationId: input.correlationId,
          gatewayId: input.gatewayId,
          externalId: input.externalId,
          expansionExternalIds: [...input.expansionExternalIds],
        },
      },
      select: { id: true },
    });

    return baseJob.id;
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
