# @bge/otel

Vendor-neutral OpenTelemetry integration for every BGE service. Emits traces, metrics, and logs to any OTLP-compatible collector via standard OTel environment variables — no BGE-specific config layer.

## Quick start

`main.ts` — must be at the top, before any module that should be auto-instrumented:

```ts
import 'reflect-metadata';
import { getActorSnapshotFromCls } from '@bge/actor-context';
import { bootstrapObservability, registerShutdownHandlers } from '@bge/otel';
import { env } from '@bge/env';

const { otel, bootstrapLogger } = bootstrapObservability({
  serviceName: 'bge-api',
  serviceVersion: process.env['npm_package_version'] ?? '0.0.0',
  environment: env.provide('NODE_ENV', { defaultValue: 'development' }),
  actorContextProvider: getActorSnapshotFromCls,
});

// ... NestFactory.create with bufferLogs: true ...

registerShutdownHandlers(app, otel, bootstrapLogger);
```

Each app's NestJS module:

```ts
import { BullMQQueueDepthRecorderModule, buildOtelPinoOptions, createBullMQTelemetry } from '@bge/otel';

@Module({
  imports: [
    LoggerModule.forRoot({ pinoHttp: buildOtelPinoOptions() }),
    BullModule.forRoot({
      connection: queueRedisClient,
      telemetry: createBullMQTelemetry(),
    }),
    BullMQQueueDepthRecorderModule,
    // ...
  ],
})
export class AppModule {}
```

`createBullMQTelemetry()` wraps `bullmq-otel` and emits the BullMQ metrics + lifecycle spans; `BullMQQueueDepthRecorderModule` keeps the `bullmq.queue.jobs` gauge fresh by calling `Queue#recordJobCountsMetric()` on a timer. Wire both — the recorder by itself emits nothing.

## Environment variables

All standard OTel vars. The two `*_EXPORTER` vars are forced to `none` if unset to prevent NodeSDK from auto-configuring exporters that would either fail (no collector for metrics) or double-ship (logs via both SDK and pino transport).

| Variable                              | Default         | Purpose                                                                                                   |
| ------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT`         | unset           | Collector URL. Unset → instrumentation runs in-process, nothing exported.                                 |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` | unset           | Per-signal override for metrics. Honored alongside the general endpoint.                                  |
| `OTEL_EXPORTER_OTLP_PROTOCOL`         | `http/protobuf` | `grpc` or `http/protobuf`. Applies to all signals.                                                        |
| `OTEL_METRICS_EXPORTER`               | `none` (forced) | Set to `otlp` to enable BGE + auto-instrumentation metrics.                                               |
| `OTEL_LOGS_EXPORTER`                  | `none` (forced) | Logs flow via `pino-opentelemetry-transport`; SDK-side export is suppressed to prevent double-ship.       |
| `OTEL_RESOURCE_ATTRIBUTES`            | unset           | Additional resource labels.                                                                               |
| `OTEL_LOG_LEVEL`                      | unset           | SDK-internal diagnostic level. Parsed (`none` / `error` / `warn` / `info` / `debug` / `verbose` / `all`). |
| `OTEL_METRIC_EXPORT_INTERVAL`         | `60000` ms      | Metric collection cycle.                                                                                  |

### Activation matrix

Metrics are enabled when BOTH `OTEL_METRICS_EXPORTER=otlp` AND an OTLP endpoint is configured (general or per-signal). This is the single gate consulted by the SDK metric reader, `createBullMQTelemetry()`, and `BullMQQueueDepthRecorder` — all three agree by construction (see `libs/common/otel/src/lib/init/metrics-enabled.ts`).

| Endpoint set? | `OTEL_METRICS_EXPORTER=otlp`? | Result                                                 |
| ------------- | ----------------------------- | ------------------------------------------------------ |
| no            | n/a                           | Instrumentation runs in-process. Nothing exported.     |
| yes           | no (default)                  | Traces and logs export. Metric instruments are no-ops. |
| yes           | yes                           | Traces, logs, and metrics all export.                  |

## Automatic instrumentation

Via `@opentelemetry/auto-instrumentations-node`: HTTP server/client, gRPC server/client, Prisma, BullMQ, IORedis, Express routing, pino, and others. W3C Trace Context (`traceparent` / `tracestate`) propagates across all of them without manual code.

## Custom span attributes

`ActorSpanProcessor` stamps every span at `onStart` from CLS:

| Attribute                   | When set        | Source               |
| --------------------------- | --------------- | -------------------- |
| `bge.actor.kind`            | actor present   | `Actor.kind`         |
| `bge.actor.plugin_id`       | plugin actors   | `Actor.pluginId`     |
| `bge.actor.trigger_kind`    | plugin actors   | `Actor.trigger.kind` |
| `bge.actor.external_system` | external actors | `Actor.system`       |
| `bge.household.id`          | when set in CLS | CLS                  |
| `bge.correlation_id`        | when set in CLS | CLS                  |

**PII policy:** spans never carry `userId`, `apiKeyId`, plugin trigger identity, or external system identifier — only kinds and non-PII tags. The full actor stays in CLS and audit log entries (#57). Adding a new `bge.*` span attribute requires updating `BGE_OTEL_ATTRIBUTES` and re-reviewing PII implications.

## Custom metrics

BullMQ metrics come from two cooperating pieces:

- **`createBullMQTelemetry()`** — passed to `BullModule.forRoot({ telemetry: ... })`. Wraps `bullmq-otel`, which registers the meter and emits `bullmq.queue.jobs` (regular gauge) plus lifecycle counters for completed / failed / retried / delayed jobs and a histogram for job duration. Trace context propagation across the queue boundary also rides on this.
- **`BullMQQueueDepthRecorderModule`** — discovers every `Queue` instance via `DiscoveryService` and calls `queue.recordJobCountsMetric()` on a timer. The gauge is a regular OTel Gauge (not an `ObservableGauge`), so its value only updates when something invokes the recording method. Without this, the gauge would stay stale at whatever it was last set to.

Gauge details:

| Metric              | Type  | Attributes                  | Unit     |
| ------------------- | ----- | --------------------------- | -------- |
| `bullmq.queue.jobs` | gauge | `queue.name`, `queue.state` | `{jobs}` |

States observed: `waiting`, `active`, `delayed`, `failed`, `completed`, `paused`, `waiting-children`. One Redis round-trip per queue per `OTEL_METRIC_EXPORT_INTERVAL`. Per-queue failure isolation — one broken Redis connection does not silence healthy queues.

Both pieces consult the same activation gate. When the gate is closed (the default), `createBullMQTelemetry()` returns a telemetry instance with no meter and the recorder stays idle — trace propagation still works.

Auto-instrumentations contribute their own metrics (HTTP request duration histograms, gRPC server metrics, Prisma query duration) flowing through the same exporter once metrics are enabled.

## Logs

`buildOtelPinoOptions()` returns pino options pre-configured with:

- A mixin that injects `trace_id` / `span_id` / `trace_flags` into every record while a span is active.
- `pino-opentelemetry-transport` as a transport target, configured automatically when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Runs in a pino worker thread.

`@opentelemetry/instrumentation-pino` (loaded by auto-instrumentations) provides additional patch-level injection. Together every log record correlates to its originating trace.

## Cross-service actor propagation

Inbound HTTP requests populate CLS via `HttpActorMiddleware`. The actor then rides:

- **Within process** — AsyncLocalStorage via `nestjs-cls`.
- **Over outbound gRPC** — `createOutboundActorMetadataInterceptor` writes `x-bge-actor` (base64 JSON of the full Actor) into gRPC metadata. Wired in `GatewayCoordinatorClientModule` via `channelOptions.interceptors`. Trace context (`traceparent` / `tracestate`) is handled independently by OTel's gRPC auto-instrumentation.
- **Into the coordinator** — `GrpcInternalActorInterceptor` reads `x-bge-actor`, structurally validates, and re-enters CLS via `auditContext.runWith`. Missing or malformed metadata throws — fail loudly on a trusted internal channel.
- **Through BullMQ** — existing `__meta` envelope on `job.data`. No fallback — jobs without `__meta` fail loudly per the pre-alpha policy.

**Trust model:** the gRPC channel itself is the boundary (mTLS or network policy in prod, loopback in dev). No signing or HMAC at this layer; receivers structurally validate but do not authenticate cryptographically.

## In-process event boundaries (EventEmitter2)

Domain events fire through `@nestjs/event-emitter`'s `EventEmitter2` instance. Unlike gRPC and BullMQ, this is not a cross-process boundary — emit and listener execute in the same Node process, in the same async chain. Both audit context (actor + correlationId + source) and OTel trace context propagate automatically through `@OnEvent` handlers via AsyncLocalStorage. No envelope is needed.

The chain that makes this work:

1. `eventEmitter.emit(name, payload)` is synchronous by default in BGE's configuration.
2. The emitter calls each registered listener — when the listener is decorated with `{ async: true }`, `@nestjs/event-emitter` schedules the handler on the next microtask/tick. ALS state from the emit call site propagates to that scheduled callback.
3. `nestjs-cls` uses AsyncLocalStorage to store the audit context; OTel's `AsyncLocalStorageContextManager` (registered globally by `initOtel`) does the same for trace context. Both propagate naturally through the scheduling boundary.
4. When the listener does `await something()`, AsyncLocalStorage continues to propagate both contexts through the awaited promise chain.
5. The emit caller is free to return immediately — they don't wait for the listener — but the listener has already captured ALS state, so its async work still sees the correct context.

Spans created inside the listener become children of the emit caller's active span, even if that parent span has already ended by the time the child fires. OTel reconstructs the parent-child relationship from span IDs at the backend; physical presence doesn't matter.

### Configurations that _would_ break propagation

None of these are current BGE patterns, but worth flagging for future contributors:

- **`emitAsync` combined with `{ async: true }` listeners.** Mutually incompatible. `{ async: true }` makes the handler schedule on the next tick and return `undefined` to EventEmitter2, leaving `emitAsync` nothing to await. The promise from `emitAsync` resolves immediately, before the listener body runs. If you ever need `emitAsync` semantics, drop `{ async: true }` from the listener and have it return a real Promise — at which point ALS still propagates correctly through the awaited chain.
- **Listeners that schedule unscoped detached timers.** `setInterval(() => doWork(), 1000)` inside a listener captures ALS _at scheduling time_, but if the work is genuinely periodic (firing long after the emit context has ended), each invocation runs in the captured context which may no longer be meaningful. Use `SystemActorScope.run(...)` inside the timer callback to enter a fresh, named system scope.
- **Cross-process event re-emission.** A hypothetical bridge that serialized events to Redis pub/sub and re-emitted them on another instance. BGE doesn't do this; if it ever does, that bridge needs its own envelope (modeled on `__meta` for BullMQ).
- **Custom emitter configurations that introduce queue-style indirection** — e.g., a wrapper that defers emit to a worker pool. The current `EventEmitterModule.forRoot({ wildcard: ..., delimiter: '.' })` configurations in every app are synchronous; changing those would invalidate the assumption here.

### Verification

Locked down by `libs/common/actor-context/src/lib/event-emitter-propagation.spec.ts`. The spec asserts CLS audit fields and an OTel context key both reach a real `@OnEvent` listener through `emit` and across awaits inside the listener body. It also verifies independence between successive emits, so a CI failure surfaces if a future change introduces context bleed.

## Shutdown sequencing

`registerShutdownHandlers(app, otel, logger)` registers `SIGTERM` and `SIGINT` handlers that:

1. Call `app.close()` — runs all `OnApplicationShutdown` providers, producing their final spans.
2. Call `otel.shutdown()` — flushes the BatchSpanProcessor and metric reader.
3. `process.exit(0)`.

Re-entrancy is guarded; a second signal during shutdown logs a warning and returns the in-flight promise.

Do **not** also call `app.enableShutdownHooks()` — Nest's own signal handlers race with ours.

## Backends

`@bge/otel` does not ship a collector — that's the operator's responsibility. Any OTLP-compatible backend works: SigNoz (all-in-one OSS), the Grafana LGTM stack, Jaeger (traces only), or `otelcol-contrib` forwarding to existing infra. Default OTLP ports: `:4318` for HTTP, `:4317` for gRPC.

## Related issues

- **#72** — original observability scope
- **#57** — actor context infrastructure (audit log foundation)
- **#81** — Prisma client metrics bridge (follow-up)
