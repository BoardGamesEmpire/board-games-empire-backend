# Feedback

User-submitted reports for crashes, bugs, and feature requests. Two moving parts:

- **`@bge/feedback`** (`libs/api/feedback`) — the domain: the `POST /feedback/reports`
  controller, persistence, server-side redaction, retention sweep, feedback bans,
  and the `feedback.report.submitted` domain event.
- **`@bge/queue-feedback`** (`libs/queue/feedback`) — sink fan-out: forwarding a
  persisted report to one or more destinations, decoupled from the domain via the
  event above.

The report is durably persisted the moment the controller returns. Sink delivery
is best-effort fan-out that happens afterward; a sink being down never loses a
report.

## Sink drivers

A **`FeedbackSink`** is a destination a report can be forwarded to. The bundled
**`LocalDatabaseSink`** (`slug: 'local'`) is the canonical reference
implementation and the floor every deployment has. External sinks (GitHub
Issues, Discord, Sentry, …) arrive as plugins once the loader (#59) lands.

```ts
interface FeedbackSink {
  readonly slug: string;                 // persisted on FeedbackSubmission.sinkSlug
  readonly bundled?: boolean;            // ships in-tree; cannot be uninstalled
  acceptsCategory?(category): boolean;   // category filter (absent = accept all)
  submit(report, context): Promise<SinkSubmissionResult>;
  syncStatus?(submission): Promise<SinkSubmissionResult>;  // deferred (see below)
}
```

Sinks are registered into the `FEEDBACK_SINKS` DI token via a `useFactory` array
in `FeedbackSinkModule` — the same idiom as `STORAGE_DRIVERS`. `FeedbackSinkRegistry`
indexes them by `slug`, fails loudly at construction on a duplicate/empty set, and
routes each delivery by the slug recorded on its `FeedbackSubmission`
(`resolve()` throws `SinkNotRegisteredError` on an unknown slug — never a
wrong-sink delivery).

## Delivery flow

1. Controller persists the `FeedbackReport`, `FeedbackService` emits
   `feedback.report.submitted`.
2. **Producer** (`FeedbackDispatcherService`, API process): resolves the sinks
   that accept the report's category and enqueues one BullMQ job per sink on the
   `feedback-delivery` queue. Fan-out is isolated per sink and never throws back
   into the emitter. Deterministic `jobId` (`feedback:<reportId>:<sinkSlug>`)
   dedups a re-emitted event to one delivery. Actor + correlation ride the
   `__meta` envelope (`wrapJobData`).
3. **Consumer** (`FeedbackDeliveryProcessor` → `FeedbackDeliveryService`, worker
   process, on `ActorAwareWorkerHost`): re-reads the report, resolves the sink,
   creates/updates one `FeedbackSubmission` row per (report, sink), and calls
   `submit()`. Success → `Submitted` (+ `externalId`/`externalUrl`); a failed
   attempt bumps `attempts`/`lastError` and rethrows so BullMQ retries; on
   exhausted attempts the processor's `onFailed` flips the row to `Failed`.

`FeedbackReport` → many `FeedbackSubmission` (one per sink; the append-only audit
of where a report was forwarded and how it fared).

Because the API produces jobs, it configures a `BullModule` root (mirroring the
worker); the worker attaches the consumer.

## Deferred (tracked as follow-up issues to #70)

- **Per-household sink selection + category filtering** — a
  `HouseholdFeedbackSinkConfig` table so households choose which sinks are active
  and which categories route where. Blocked on the plugin loader (#59). Today the
  category filter is a per-sink static `acceptsCategory()`; the bundled local sink
  accepts everything. `FeedbackSinkRegistry.sinksAccepting()` is the seam this
  will layer onto.
- **Auto-disable of a repeatedly-failing sink** — the race-safe
  `updateMany(...Active -> Disabled) count===0` pattern used by the webhook queue.
  Needs the per-sink config row above to hold the consecutive-failure counter and
  disabled flag. Bundled sinks are always-on, so there is nothing to disable yet;
  the seam is marked in `FeedbackDeliveryService.recordTerminalFailure`.
- **`syncStatus()` implementation** — pulling external state back onto a
  submission (e.g. a GitHub issue closed). The interface method exists; no sink
  implements it yet.
- **Plugin sinks** (GitHub, GitLab, Linear, Jira, Discord, generic webhook) —
  each its own issue, all blocked on #59.
