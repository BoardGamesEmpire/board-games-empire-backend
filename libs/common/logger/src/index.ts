export { buildBasePinoOptions, resolvePinoLevel } from './lib/base-pino.options';
export { bootstrapLogging, type BootstrapLoggingConfig } from './lib/bootstrap-logging';
export {
  createLoggerShutdown,
  registerLoggerShutdown,
  type LoggerShutdownFn,
  type ShutdownableApp,
} from './lib/register-logger-shutdown';
