import {
  DatabaseService,
  InitiatorType,
  isPrismaUniqueConstraintError,
  JobStatus,
  JobType,
  Prisma,
} from '@bge/database';
import type { JobActorMeta } from '@bge/queue-actor-context';
import { InjectFlowProducer } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { FlowProducer } from 'bullmq';
import { FlowProducerNames } from '../constants/queue.constants';
import { buildBaseFlow, buildExpansionFlow } from '../flows/import-flow.builder';
import {
  ImportJobOrigin,
  type ExpansionImportJobPayload,
  type GameImportJobPayload,
} from '../interfaces/import-job.interface';
import { idempotencyKeyFor } from '../utils/idempotency-key';

export interface SpawnExpansionsInput {
  /** The base Job row id — becomes each expansion row's parentJobId. */
  baseJobId: string;
  batchId: string;
  correlationId: string;
  gatewayId: string;
  /**
   * External id of the requested game — recorded on each expansion, which
   * links to it when its DataGateway names no base game (#971).
   */
  requestedExternalId: string;
  expansionExternalIds: string[];
  locale?: string;
  initiatorType: InitiatorType;
  userId: string | null;
}

export interface SpawnBaseGameInput {
  /** The Job row id of the game that needs the base game — becomes its parentJobId. */
  parentJobId: string;
  batchId: string;
  correlationId: string;
  gatewayId: string;
  /** External id of the base game to add. */
  externalId: string;
  locale?: string;
  initiatorType: InitiatorType;
  userId: string | null;
}

/**
 * Creates and enqueues the flows of the expansions chosen with a requested
 * game, once its DataGateway link exists, and the flow of a base game that a
 * game in the batch needs (#971). Runs in apps/worker (a *producer* to the
 * fetch queue — it never consumes fetch jobs, so the worker still never calls
 * a gateway).
 *
 * Idempotent by construction, so a retry of the requested game's import
 * re-runs it harmlessly:
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
              requestedExternalId: input.requestedExternalId,
              origin: ImportJobOrigin.ChosenExpansion,
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
            requestedExternalId: input.requestedExternalId,
            initiatorType: input.initiatorType,
            userId: input.userId,
            locale: input.locale,
            origin: ImportJobOrigin.ChosenExpansion,
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

  /**
   * Adds a base game to the import batch, for a game whose DataGateway names
   * base games none of which is in the game catalog (#971). The base game is
   * imported as any game is, and adds no base game of its own.
   *
   * One row per base game per batch, on an `added-base` idempotencyKey: when
   * two chosen expansions need the same base game, the second finds the
   * first's row and adds nothing, so the row stays parented on whichever got
   * there first. A flow is enqueued only while the row is Pending, and its
   * jobId is the row id, so a re-add de-dupes at BullMQ.
   *
   * Nothing is added when the batch already imports the game as its requested
   * game or a chosen expansion, such as an expansion chosen with the base game
   * it expands: that job imports it, and whichever of the two persists second
   * links them.
   */
  async spawnBaseGame(input: SpawnBaseGameInput, meta: JobActorMeta): Promise<void> {
    if (await this.batchImports(input.batchId, input.externalId)) {
      this.logger.log(
        `Base game externalId=${input.externalId} for jobId=${input.parentJobId} is already in batchId=${input.batchId}`,
      );
      return;
    }

    const row = await this.addBaseGameRow(input);
    if (row.status !== JobStatus.Pending) {
      return;
    }

    await this.flowProducer.add(
      buildBaseFlow(
        {
          jobId: row.id,
          batchId: input.batchId,
          correlationId: input.correlationId,
          gatewayId: input.gatewayId,
          externalId: input.externalId,
          initiatorType: input.initiatorType,
          userId: input.userId,
          locale: input.locale,
          origin: ImportJobOrigin.AddedBaseGame,
        } satisfies GameImportJobPayload,
        meta,
      ),
    );

    this.logger.log(
      `Added base game externalId=${input.externalId} for jobId=${input.parentJobId} batchId=${input.batchId}`,
    );
  }

  /**
   * True when the batch already has a job importing the game as its requested
   * game or a chosen expansion. Both rows exist before any job in the batch
   * can add a base game: the requested game's row comes with the batch, and
   * the chosen expansions' rows are written before their flows start.
   */
  private async batchImports(batchId: string, externalId: string): Promise<boolean> {
    const row = await this.db.job.findFirst({
      where: {
        idempotencyKey: {
          in: [idempotencyKeyFor(batchId, 'base', externalId), idempotencyKeyFor(batchId, 'exp', externalId)],
        },
      },
      select: { id: true },
    });

    return row !== null;
  }

  /**
   * Upserts the added base game's row. Two imports needing the same base game
   * at the same moment can both miss the row and race to create it; the one
   * that loses the unique constraint reads the winner's row instead.
   */
  private async addBaseGameRow(input: SpawnBaseGameInput): Promise<{ id: string; status: JobStatus }> {
    const key = idempotencyKeyFor(input.batchId, 'added-base', input.externalId);
    const select = { id: true, status: true } as const;

    try {
      return await this.db.job.upsert({
        where: { idempotencyKey: key },
        create: {
          type: JobType.GameImport,
          status: JobStatus.Pending,
          initiatorType: input.initiatorType,
          userId: input.userId,
          batchId: input.batchId,
          parentJobId: input.parentJobId,
          idempotencyKey: key,
          payload: {
            correlationId: input.correlationId,
            gatewayId: input.gatewayId,
            externalId: input.externalId,
            origin: ImportJobOrigin.AddedBaseGame,
          } satisfies Prisma.InputJsonObject,
        },
        update: {},
        select,
      });
    } catch (error) {
      if (!isPrismaUniqueConstraintError(error)) {
        throw error;
      }

      const raced = await this.db.job.findUnique({ where: { idempotencyKey: key }, select });
      if (!raced) {
        throw error;
      }

      return raced;
    }
  }
}
