import type { JobType, NotificationType } from '@bge/database';

export interface NotificationPayload {
  baseGameId?: string;
  baseGameTitle?: string;
  batchId?: string;
  gameId?: string;
  gameTitle?: string;
  jobId?: string;
  thumbnail?: string | null;

  // ImportFailed — jobType discriminates the import domain (game vs future
  // profile sync etc.); the rest is jobType-specific failure detail. error is
  // the sanitized, user-safe message and errorCode its stable classification
  // (typed as string here to avoid coupling this common lib to game-import's
  // ImportErrorCode); the raw failure text stays in Job.error / operator logs.
  error?: string;
  errorCode?: string;
  externalId?: string;
  gatewayId?: string;
  isExpansion?: boolean;
  jobType?: JobType;
}

export interface CreateNotificationInput<Payload extends Record<string, any> = Record<string, any>> {
  payload: Payload;
  type: NotificationType;
  userId: string;
}

export interface UnreadNotificationDto {
  createdAt: Date;
  id: string;
  payload: NotificationPayload;
  read: boolean;
  type: NotificationType;
}
