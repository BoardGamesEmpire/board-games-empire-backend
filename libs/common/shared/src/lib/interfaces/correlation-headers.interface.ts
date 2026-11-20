export interface CorrelationHeaders {
  readonly correlationId?: string | string[] | undefined;
  readonly traceparent?: string | string[] | undefined;
}
