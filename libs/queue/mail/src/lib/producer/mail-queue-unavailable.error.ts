/**
 * The mail queue's Redis connection is not up, so nothing was queued (#654).
 * Thrown at once instead of waiting: the queue's client holds a command until
 * Redis is back, which would leave a request open and keep a reset link in
 * memory for as long as Redis stays down, then send it late.
 */
export class MailQueueUnavailableError extends Error {
  constructor() {
    super('The mail queue is unavailable');
    this.name = 'MailQueueUnavailableError';
  }
}
