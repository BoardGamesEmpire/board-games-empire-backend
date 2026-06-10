import { DiagLogLevel } from '@opentelemetry/api';

/**
 * Standard OpenTelemetry environment variable controlling SDK-internal
 * diagnostic verbosity.
 */
export const OTEL_LOG_LEVEL_ENV = 'OTEL_LOG_LEVEL';

/**
 * Maps OTel-standard `OTEL_LOG_LEVEL` string values to {@link DiagLogLevel}
 * tokens. Comparison is case-insensitive — `resolveDiagLogLevel`
 * lowercases the value before lookup.
 */
export const OTEL_DIAG_LEVEL_MAP: Readonly<Record<string, DiagLogLevel>> = {
  none: DiagLogLevel.NONE,
  error: DiagLogLevel.ERROR,
  warn: DiagLogLevel.WARN,
  info: DiagLogLevel.INFO,
  debug: DiagLogLevel.DEBUG,
  verbose: DiagLogLevel.VERBOSE,
  all: DiagLogLevel.ALL,
};

/**
 * Resolves the desired diag log level from the standard OTel env var.
 *
 * Returns:
 * - {@link DiagLogLevel.INFO} when the env var is unset (the default).
 * - The mapped level when the value is a recognized token
 *   (`none | error | warn | info | debug | verbose | all`).
 * - {@link DiagLogLevel.INFO} when the value is set but unrecognized —
 *   chosen over throwing so a typo doesn't break bootstrap. Operators
 *   who set a non-standard value silently get the default.
 *
 * Single source of truth — consulted by both `initOtel` (which sets up
 * the initial stderr-backed diag logger) and `bootstrapObservability`
 * (which then upgrades to a pino-backed diag bridge). Both must read
 * the same value or the upgrade phase silently overrides the operator's
 * selection.
 *
 * Takes an explicit `env` parameter (default `process.env`) so tests
 * can pass deterministic env objects without mutating global state.
 */
export function resolveDiagLogLevel(env: NodeJS.ProcessEnv = process.env): DiagLogLevel {
  const otelLogLevel = env[OTEL_LOG_LEVEL_ENV];
  if (!otelLogLevel) {
    return DiagLogLevel.INFO;
  }
  return OTEL_DIAG_LEVEL_MAP[otelLogLevel.toLowerCase()] ?? DiagLogLevel.INFO;
}
