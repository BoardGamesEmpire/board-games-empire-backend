import type { MailMessage } from '@bge/mail';

/**
 * One outgoing mail. The job names the recipient by id, and the worker reads
 * the address and language from the user row when it sends, so a changed
 * address or language reaches a retry. A password reset's `message` carries a
 * single-use link, so nothing may log a job's data (#654).
 *
 * Actor and correlation ride in the `__meta` envelope (`wrapJobData`).
 */
export interface MailDeliveryJob {
  readonly recipientUserId: string;
  readonly message: MailMessage;
}
