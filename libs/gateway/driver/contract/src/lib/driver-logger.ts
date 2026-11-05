/**
 * Where a DataGateway driver writes its log lines. The same shape as a
 * plugin's logger, so a plugin DataGateway can pass its context's, and a
 * remote DataGateway's app passes one over its own logger (#1082).
 */
export interface DriverLogger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
