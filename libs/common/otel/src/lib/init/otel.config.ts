import type { ActorContextProvider } from '../processors/actor-context-provider';

/**
 * Static configuration supplied by each app at OTel SDK init time. Lives
 * in the call to {@link initOtel} from `main.ts` before NestFactory.
 *
 * Runtime knobs — endpoint, protocol, sampler, resource overrides — come
 * from standard OTel environment variables (`OTEL_EXPORTER_OTLP_ENDPOINT`,
 * `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_TRACES_SAMPLER`,
 * `OTEL_TRACES_SAMPLER_ARG`, `OTEL_RESOURCE_ATTRIBUTES`). BGE deliberately
 * does NOT introduce its own configuration layer for these; operators use
 * the vendor-standard variables that any OTLP collector expects.
 *
 * When `OTEL_EXPORTER_OTLP_ENDPOINT` is unset, the SDK initializes with
 * no exporter — instrumentation runs (and is read by in-process consumers
 * like the `ActorSpanProcessor`) but no spans are exported. No errors,
 * no network cost.
 */
export interface OtelInitConfig {
  /**
   * Returns the current audit context snapshot for span annotation. The
   * host application closes over `ClsServiceManager.getClsService()` (or
   * an equivalent reader) so `@bge/otel` stays decoupled from
   * `@bge/actor-context` CLS internals.
   */
  readonly actorContextProvider: ActorContextProvider;

  /**
   * Deployment environment, e.g. `'production'`, `'staging'`, `'dev'`.
   */
  readonly environment?: string;

  /**
   * Logical service identifier, e.g. `'bge-api'`, `'bge-coordinator'`.
   */
  readonly serviceName: string;

  /**
   * Namespace grouping all BGE services on a Resource. Defaults to {@link DEFAULT_SERVICE_NAMESPACE}.
   */
  readonly serviceNamespace?: string;

  /**
   * Service version, typically read from the app's `package.json`.
   */
  readonly serviceVersion: string;
}

/**
 * Default `service.namespace` stamped on every span's Resource.
 */
export const DEFAULT_SERVICE_NAMESPACE = 'bge';

/**
 * Env var that gates OTLP export. When unset, the SDK runs with no exporter.
 */
export const OTEL_EXPORTER_OTLP_ENDPOINT_ENV = 'OTEL_EXPORTER_OTLP_ENDPOINT';

/**
 * Env var selecting between `grpc` and `http/protobuf` OTLP transports.
 */
export const OTEL_EXPORTER_OTLP_PROTOCOL_ENV = 'OTEL_EXPORTER_OTLP_PROTOCOL';

/**
 * Env var selecting the metrics exporter. NodeSDK defaults to `'otlp'`
 * when an endpoint is set; we override that default to `'none'` because
 * BGE metrics infrastructure ships separately and we don't want the
 * auto-instrumentation meters spamming a collector that isn't expecting
 * them.
 */
export const OTEL_METRICS_EXPORTER_ENV = 'OTEL_METRICS_EXPORTER';

/**
 * Env var selecting the logs exporter. NodeSDK defaults to `'otlp'` when
 * an endpoint is set; we override that default to `'none'` because
 * `pino-opentelemetry-transport` ships logs from a worker thread, and a
 * second SDK-side log exporter would double-ship.
 */
export const OTEL_LOGS_EXPORTER_ENV = 'OTEL_LOGS_EXPORTER';

/**
 * The spec's batch span processor variables, which `initOtel` passes to the
 * processor it builds for the trace exporter (#957).
 */
export const OTEL_BSP_EXPORT_TIMEOUT_ENV = 'OTEL_BSP_EXPORT_TIMEOUT';
export const OTEL_BSP_MAX_EXPORT_BATCH_SIZE_ENV = 'OTEL_BSP_MAX_EXPORT_BATCH_SIZE';
export const OTEL_BSP_MAX_QUEUE_SIZE_ENV = 'OTEL_BSP_MAX_QUEUE_SIZE';
export const OTEL_BSP_SCHEDULE_DELAY_ENV = 'OTEL_BSP_SCHEDULE_DELAY';

/**
 * OTLP protocol token requesting gRPC transport.
 */
export const OTEL_OTLP_PROTOCOL_GRPC = 'grpc';

/**
 * OTLP protocol token requesting HTTP+protobuf transport (OTel default).
 */
export const OTEL_OTLP_PROTOCOL_HTTP = 'http/protobuf';

/**
 * Sentinel value disabling a signal exporter (metrics, logs).
 */
export const OTEL_EXPORTER_NONE = 'none';
