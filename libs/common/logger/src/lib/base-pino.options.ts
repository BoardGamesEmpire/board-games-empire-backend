import type { LoggerOptions, TransportTargetOptions } from 'pino';

/**
 * Default log level when `NODE_ENV === 'production'` and `LOG_LEVEL`
 * is unset. Quieter than the development default so production logs
 * don't drown in `debug` records, but verbose enough that operational
 * `info`-level lifecycle events remain visible.
 */
const PRODUCTION_DEFAULT_LEVEL = 'info';

/**
 * Default log level outside of production when `LOG_LEVEL` is unset.
 * Verbose by intent — local development benefits from per-handler
 * `debug` records that production volume would make impractical.
 */
const NON_PRODUCTION_DEFAULT_LEVEL = 'debug';

/**
 * The request and response header values censored on every log line (#748).
 * pino-http serializes the full header set onto `req` and `res`, so without
 * these paths a bearer token, a session cookie or an API key reaches the log
 * verbatim. The paths are exact, not wildcards: they name the three request
 * credentials and the response's `set-cookie`, and a header the request did
 * not carry gets no placeholder. `set-cookie` is an array whenever the
 * response sets more than one cookie, and pino censors the whole value.
 */
const CREDENTIAL_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

/**
 * Resolves the pino log level from the supplied env. Reads
 * `env['LOG_LEVEL']` first; falls back to
 * {@link PRODUCTION_DEFAULT_LEVEL} when `env['NODE_ENV'] === 'production'`
 * and to {@link NON_PRODUCTION_DEFAULT_LEVEL} otherwise.
 *
 * Exported so callers that layer additional transport targets on top
 * of {@link buildBasePinoOptions} (notably `buildOtelPinoOptions` in
 * `@bge/otel`, which appends a `pino-opentelemetry-transport` target)
 * can apply the same level to those targets without duplicating the
 * resolution logic.
 */
export function resolvePinoLevel(env: NodeJS.ProcessEnv): string {
  const isProduction = env['NODE_ENV'] === 'production';
  return env['LOG_LEVEL'] ?? (isProduction ? PRODUCTION_DEFAULT_LEVEL : NON_PRODUCTION_DEFAULT_LEVEL);
}

/**
 * Returns pino options pre-configured with BGE-wide defaults that do
 * NOT depend on OpenTelemetry:
 *
 * - The log level is read from `env['LOG_LEVEL']`, defaulting to
 *   `'info'` in production and `'debug'` otherwise (see
 *   {@link resolvePinoLevel}).
 * - A single `pino-pretty` transport target is always configured
 *   (colorized, single-line). `pino-pretty` is a no-op for colors in
 *   non-TTY destinations, so the colorize flag is safe in production
 *   pipelines that ship to file or stdout-consuming collectors.
 * - The request and response credential headers are redacted (see
 *   {@link CREDENTIAL_PATHS}), so every process role that builds on these
 *   options keeps them out of its log lines.
 *
 * Every env-derived value is read from the `env` parameter (default:
 * `process.env`). The function intentionally does not consult
 * `@bge/env` or `process.env` directly — passing a custom `env` object
 * fully controls the produced options, which keeps tests deterministic
 * and matches the parameter contract a caller would reasonably expect.
 *
 * Designed to be either:
 * - Consumed directly by services that have no OTel pipeline (the BGG
 *   and IGDB DataGateways), passed to `bootstrapLogging` and then to
 *   `LoggerModule.forRoot({ pinoHttp: { logger } })`.
 * - Composed by `@bge/otel`'s `buildOtelPinoOptions`, which appends
 *   the OTel trace correlation mixin and the conditional
 *   `pino-opentelemetry-transport` target.
 *
 * The base options already redact credentials; the caller adds only
 * app-specific pino options not derived from env (serializers, custom
 * hooks).
 */
export function buildBasePinoOptions(env: NodeJS.ProcessEnv = process.env): LoggerOptions {
  const level = resolvePinoLevel(env);

  const transportTargets: TransportTargetOptions[] = [
    {
      target: 'pino-pretty',
      level,
      options: {
        colorize: true,
        singleLine: true,
      },
    },
  ];

  return {
    level,
    redact: { paths: CREDENTIAL_PATHS },
    transport: {
      targets: transportTargets,
    },
  };
}
