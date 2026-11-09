import { JobStatus } from '@bge/database';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ImportBatchStatus, ImportJobOrigin } from '../interfaces/import-job.interface';
import { ImportErrorCode } from '../utils/sanitize-import-error';

export class ImportPlatformGameDto {
  @ApiProperty({ description: 'Platform the game was linked to' })
  platformId!: string;

  @ApiProperty({
    description: 'PlatformGame id — the key collections (and other platform-scoped features) reference',
  })
  platformGameId!: string;
}

export class ImportJobStatusDto {
  @ApiProperty({ description: 'BGE Job id (baseJobId / expansionJobIds from POST /games/import)' })
  jobId!: string;

  @ApiProperty({
    enum: JobStatus,
    description: 'Current job state. Pending and Running are in-flight; Completed, Failed, and Cancelled are terminal.',
  })
  status!: JobStatus;

  @ApiProperty({
    enum: ImportJobOrigin,
    enumName: 'ImportJobOrigin',
    description:
      'Why the job is in the batch: Requested is the game the import asked for, ChosenExpansion is an ' +
      'expansion chosen with it, and AddedBaseGame is a base game the server added because a game in the ' +
      'batch needed it. It says nothing about whether the game is an expansion; see the game itself.',
  })
  origin!: ImportJobOrigin;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Job id of the job that brought this one into the batch: the requested game for a chosen expansion, ' +
      'or the game that needed an added base game. Null for the requested game. Lets a client draw the ' +
      "batch's graph.",
  })
  parentJobId?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description:
      'External ids of the expansions chosen with the requested game. Present on its job only. Their jobs ' +
      'are added once the requested game persists, so before then (or if it fails) they have no job entry ' +
      'yet — render these as pending or skipped nodes off the requested game.',
  })
  requestedExpansions?: string[];

  @ApiProperty({ description: 'External id of the game on the gateway' })
  externalId!: string;

  @ApiPropertyOptional({ description: 'Persisted Game id — present once the job completes' })
  gameId?: string;

  @ApiPropertyOptional({ description: 'Game title — present once the job completes' })
  gameTitle?: string;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'Thumbnail URL — present once the job completes' })
  thumbnail?: string | null;

  @ApiPropertyOptional({
    type: [ImportPlatformGameDto],
    description: 'PlatformGame ids created/resolved by the import — present once the job completes',
  })
  platformGames?: ImportPlatformGameDto[];

  @ApiPropertyOptional({
    enum: ImportErrorCode,
    description: 'Stable failure classification — present when status is Failed',
  })
  errorCode?: ImportErrorCode;

  @ApiPropertyOptional({
    type: String,
    description:
      'Sanitized, static failure message — present when status is Failed. This endpoint is not owner-scoped, ' +
      'so it never returns the raw internal error text (see errorCode for machine-readable detail). Localized ' +
      'per request from errorCode; the wire value is always a string.',
  })
  // Wire contract is a plain string; toJobDto assigns an I18nMessage marker that
  // I18nResponseInterceptor renders to a localized string before serialization.
  error?: string;

  @ApiPropertyOptional({ type: Date, nullable: true })
  startedAt?: Date | null;

  @ApiPropertyOptional({ type: Date, nullable: true })
  completedAt?: Date | null;
}

export class ImportBatchStatusResponseDto {
  @ApiProperty({ description: 'Batch id returned by POST /games/import' })
  batchId!: string;

  @ApiProperty({ description: 'Correlation id supplied when the import was started' })
  correlationId!: string;

  @ApiProperty({
    enum: ImportBatchStatus,
    description:
      'Rollup of every job in the batch. Terminal states: Completed, PartiallyCompleted, Failed, Cancelled. ' +
      'Pending/Running have no server-side timeout — clients should apply their own polling deadline.',
  })
  status!: ImportBatchStatus;

  @ApiProperty({ type: [ImportJobStatusDto], description: 'Base job first, then expansions' })
  jobs!: ImportJobStatusDto[];
}
