/**
 * Transport-layer constants for the webhook delivery queue. These belong to the
 * queue lib — they describe how deliveries move through BullMQ, not the webhook
 * domain. Domain constants (event names like `WEBHOOK_DISABLED_EVENT`) stay in
 * `@bge/webhooks`.
 */

/** BullMQ queue carrying one job per (event, subscription) delivery. */
export const WEBHOOK_QUEUE_NAME = 'webhook-delivery';

/** Single job name on the delivery queue. */
export const WEBHOOK_DELIVERY_JOB = 'deliver';

/**
 * Consecutive *terminal* delivery failures (a job that exhausted its BullMQ
 * attempts) that trip auto-disable. Reset to 0 on any successful delivery and
 * on manual re-activation. Mirrors the gateway-registry FAILURE_THRESHOLD.
 */
export const WEBHOOK_FAILURE_THRESHOLD = 3;

/** Default BullMQ attempts per delivery job (exponential backoff between them). */
export const WEBHOOK_DELIVERY_ATTEMPTS = 5;

/** Base backoff in ms for the delivery job's exponential retry. */
export const WEBHOOK_DELIVERY_BACKOFF_MS = 2_000;

/** Per-delivery HTTP timeout handed to SecureHttpService. */
export const WEBHOOK_DELIVERY_TIMEOUT_MS = 10_000;

/**
 * How many terminally-failed delivery jobs to retain in Redis (newest-first).
 * Bounds the failed set instead of keeping every failure forever, while leaving
 * a recent tail for inspection/debugging.
 */
export const WEBHOOK_FAILED_JOB_RETENTION = 1_000;

/** Signed-delivery headers. HTTP 2xx is success; anything else is a failure. */
export const WEBHOOK_DELIVERY_HEADERS = {
  signature: 'X-BGE-Signature',
  timestamp: 'X-BGE-Timestamp',
  event: 'X-BGE-Event',
  deliveryId: 'X-BGE-Delivery-Id',
} as const;
