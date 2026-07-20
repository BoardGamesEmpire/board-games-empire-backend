import { FeedbackReport } from '@bge/database';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Minimal submission receipt. The submit endpoint returns only enough for the
 * client to acknowledge the report ("Report submitted (id: …)") without leaking
 * any other server-side state (status, redaction flags, deployment snapshot).
 * Reading a report back is the job of the future admin triage endpoints, which
 * will define their own role-scoped DTO.
 */
export class FeedbackReceiptDto {
  @ApiProperty({ description: 'Server-assigned report id.' })
  id!: string;

  @ApiProperty({ description: 'When the report was persisted.' })
  createdAt!: Date;

  static fromEntity(entity: Pick<FeedbackReport, 'id' | 'createdAt'>): FeedbackReceiptDto {
    const dto = new FeedbackReceiptDto();

    dto.id = entity.id;
    dto.createdAt = entity.createdAt;

    return dto;
  }
}
