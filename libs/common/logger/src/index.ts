export { buildBasePinoOptions, resolvePinoLevel, type LogDestination } from './lib/base-pino.options';
export { bootstrapLogging, type BootstrapLoggingConfig } from './lib/bootstrap-logging';
export * from './lib/nest-logger';
export {
  createLoggerShutdown,
  registerLoggerShutdown,
  type LoggerShutdownFn,
  type ShutdownableApp,
} from './lib/register-logger-shutdown';
