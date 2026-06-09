export interface CorrelationHeaders {
  readonly traceparent?: string | string[] | undefined;
  readonly correlationId?: string | string[] | undefined;
}
