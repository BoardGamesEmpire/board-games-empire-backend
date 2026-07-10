import { ApiProperty } from '@nestjs/swagger';

export class AuditLogEntryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'Raw event name as emitted (e.g. "event.created")' })
  event!: string;

  @ApiProperty({ type: Object, description: 'Serialized Actor union — full fidelity' })
  actor!: Record<string, unknown>;

  @ApiProperty({ description: "Actor variant: 'user' | 'anonymous' | 'apiKey' | 'system' | 'external' | 'plugin'" })
  actorKind!: string;

  @ApiProperty({ type: String, nullable: true, description: 'Owning user id when the actor variant carries one' })
  actorUserId!: string | null;

  @ApiProperty({ description: "'create' | 'update' | 'delete'" })
  action!: string;

  @ApiProperty({ description: 'Domain model name (ResourceType value)' })
  subject!: string;

  @ApiProperty()
  subjectId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Origin transport ('http' | 'grpc' | 'queue' | 'ws' | 'system'); null when unattributed",
  })
  source!: string | null;

  @ApiProperty({ type: String, nullable: true })
  correlationId!: string | null;

  @ApiProperty({ type: Object, description: '{ before, after } snapshots, post-@AuditExclude redaction' })
  payload!: Record<string, unknown>;

  @ApiProperty({ description: "Start of the emitting step's unit of work" })
  initiatedAt!: Date;

  @ApiProperty({ description: 'Moment the mutation completed — sort key' })
  occurredAt!: Date;

  @ApiProperty({ description: 'Audit-listener insertion time (pipeline debugging)' })
  recordedAt!: Date;
}

export class AuditLogListResponseDto {
  @ApiProperty({ type: [AuditLogEntryDto] })
  auditLogs!: AuditLogEntryDto[];
}
