import type { NotificationType } from '@bge/database';

export interface NotificationPayload {
  baseGameId?: string;
  baseGameTitle?: string;
  batchId?: string;
  gameId?: string;
  gameTitle?: string;
  jobId?: string;
  thumbnail?: string | null;
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
