/** Thrown to mark a delivery attempt as failed so BullMQ retries it. */
export class WebhookDeliveryFailedError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WebhookDeliveryFailedError';
  }
}
