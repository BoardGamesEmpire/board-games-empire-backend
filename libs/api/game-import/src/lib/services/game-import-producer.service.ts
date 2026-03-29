import { GatewayCoordinatorClientService } from '@bge/coordinator';
import { DatabaseService, InitiatorType, JobStatus, JobType } from '@bge/database';
import type { GameData } from '@board-games-empire/proto-gateway';
import { InjectFlowProducer } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { FlowChildJob, FlowProducer } from 'bullmq';
import * as crypto from 'node:crypto';
import { from, Observable, of, throwError } from 'rxjs';
import { filter, map, mergeMap, tap, toArray } from 'rxjs/operators';
import { FlowProducerNames, JobNames, QueueNames } from '../constants/queue.constants';
import type { ImportStartDto } from '../dto/import-start.dto';
import type { ExpansionImportJobPayload, GameImportJobPayload } from '../interfaces/import-job.interface';

export interface EnqueueResult {
  batchId: string;
  baseJobId: string;
  expansionJobIds: string[];
}

@Injectable()
export class GameImportProducerService {
  private readonly logger = new Logger(GameImportProducerService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly coordinator: GatewayCoordinatorClientService,
    @InjectFlowProducer(FlowProducerNames.GamesImport)
    private readonly flowProducer: FlowProducer,
  ) {}

  enqueue(dto: ImportStartDto, userId: string | null): Observable<EnqueueResult> {
    const batchId = crypto.randomUUID();

    return this.coordinator
      .fetchGame({
        correlationId: dto.correlationId,
        gatewayId: dto.gatewayId,
        externalId: dto.externalId,
      })
      .pipe(
        mergeMap((fetchResponse) => {
          if (fetchResponse.game) {
            return of(fetchResponse.game);
          }

          return throwError(
            () =>
              new Error(
                `FetchGame returned no game data for gatewayId=${dto.gatewayId} externalId=${dto.externalId}. ` +
                  `Status: ${fetchResponse.status}`,
              ),
          );
        }),

        // retrieve expansion data in sequence after base game
        mergeMap((baseGame) => from(this.fetchExpansions(dto)).pipe(map((expansions) => ({ baseGame, expansions })))),

        // create all jobs in memory first, then persist to Redis in a single flowProducer.add() call to ensure atomicity and correct
        // parent-child relationships
        mergeMap(({ baseGame, expansions }) =>
          this.createImportJob(batchId, dto, dto.externalId, baseGame, userId).pipe(
            mergeMap((baseJob) =>
              this.createExpansionJobs(batchId, expansions, dto, baseJob.jobId, userId).pipe(
                map((expansionJobs) => ({ baseJob, expansionJobs })),
              ),
            ),
          ),
        ),

        mergeMap(({ baseJob, expansionJobs }) =>
          from(
            this.flowProducer.add({
              name: JobNames.GameImport,
              queueName: QueueNames.GamesImport,
              data: baseJob,
              children: expansionJobs,
            }),
          ).pipe(
            tap(() =>
              this.logger.log(`Enqueued import batchId=${batchId}: 1 base + ${expansionJobs.length} expansions`),
            ),
            map(() => ({
              batchId,
              baseJobId: baseJob.jobId,
              expansionJobIds: expansionJobs.map((j) => j.data.jobId),
            })),
          ),
        ),
      );
  }

  /**
   * Fetches expansion data for the given DTO. Expansions that fail to fetch or have no game data are skipped
   *
   * @param dto
   * @returns Observable of successfully fetched expansions with game data
   */
  private fetchExpansions(dto: ImportStartDto): Observable<ExpansionContent[]> {
    return from(dto.expansionExternalIds ?? []).pipe(
      mergeMap((expansionExternalId) =>
        from(
          this.coordinator
            .fetchGame({
              correlationId: dto.correlationId,
              gatewayId: dto.gatewayId,
              externalId: expansionExternalId,
            })
            .pipe(
              mergeMap((expResponse) => {
                if (expResponse.game) {
                  return of({ externalId: expansionExternalId, gameData: expResponse.game });
                }

                this.logger.warn(
                  `FetchGame returned no data for expansion externalId=${expansionExternalId}, skipping.`,
                );
                return of(null);
              }),
            ),
        ),
      ),
      filter((result): result is ExpansionContent => result !== null),
      toArray(),
    );
  }

  /**
   * Creates import jobs for expansions. Each expansion job is linked as a child to the base game job.
   *
   * @param batchId
   * @param expansionContent
   * @param dto
   * @param baseJobId
   * @param userId
   * @returns Observable of created expansion jobs with correct parent-child relationships to the base game job
   */
  private createExpansionJobs(
    batchId: string,
    expansionContent: ExpansionContent[],
    dto: ImportStartDto,
    baseJobId: string,
    userId: string | null,
  ): Observable<FlowChildJob[]> {
    return from(expansionContent).pipe(
      mergeMap((expansion) =>
        this.createImportJob(batchId, dto, expansion.externalId, expansion.gameData, userId, baseJobId).pipe(
          map<GameImportJobPayload, ExpansionImportJobPayload>((payload) => ({
            ...payload,
            baseGameExternalId: dto.externalId,
          })),
        ),
      ),
      map<ExpansionImportJobPayload, FlowChildJob>((payload) => ({
        name: JobNames.ExpansionImport,
        queueName: QueueNames.GamesImport,
        data: payload,
      })),
      toArray(),
    );
  }

  /**
   * Creates an import job for a game or expansion. If baseJobId is provided, the job is considered an expansion and will be linked as a child to the base game job.
   *
   * @param batchId
   * @param dto
   * @param externalId
   * @param gameData
   * @param userId
   * @param baseJobId
   * @returns Observable of the created import job payload
   */
  private createImportJob(
    batchId: string,
    dto: ImportStartDto,
    externalId: string,
    gameData: GameData,
    userId: string | null,
    baseJobId: string | null = null,
  ) {
    return from(
      this.db.job.create({
        data: {
          type: JobType.GameImport,
          status: JobStatus.Pending,
          initiatorType: userId ? InitiatorType.User : InitiatorType.System,
          userId,
          batchId,
          parentJobId: baseJobId,
          payload: { gatewayId: dto.gatewayId, externalId },
        },
        select: { id: true },
      }),
    ).pipe(
      map<{ id: string }, GameImportJobPayload>((job) => ({
        initiatorType: userId ? InitiatorType.User : InitiatorType.System,
        correlationId: dto.correlationId,
        gatewayId: dto.gatewayId,
        jobId: job.id,
        gameData,
        batchId,
        userId,
      })),
    );
  }
}

interface ExpansionContent {
  externalId: string;
  gameData: GameData;
}
