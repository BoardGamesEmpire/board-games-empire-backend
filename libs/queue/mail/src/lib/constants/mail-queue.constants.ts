/**
 * Transport-layer constants for the outgoing mail queue (#654): how mail moves
 * through BullMQ, not what a message says. The api adds jobs; the worker is the
 * only process that connects to an SMTP server.
 */

/** BullMQ queue carrying one job per outgoing mail. */
export const MAIL_QUEUE_NAME = 'mail-delivery';

/** Single job name on the mail queue. */
export const MAIL_DELIVERY_JOB = 'deliver';

/** BullMQ attempts for a mail that nobody is waiting on, such as a password reset. */
export const MAIL_DELIVERY_ATTEMPTS = 5;

/** Base backoff in ms for the exponential retry between attempts. */
export const MAIL_DELIVERY_BACKOFF_MS = 5_000;

/** One try for a test email, so the admin hears the outcome at once. */
export const MAIL_TEST_ATTEMPTS = 1;
