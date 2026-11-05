import type { DriverLogger } from '@boardgamesempire/gateway-driver-contract';
import { Logger } from '@nestjs/common';

/** A DriverLogger that writes through Nest's Logger under `context`, so a driver's lines join the app's (#1082). */
export function createDriverLogger(context: string): DriverLogger {
  const logger = new Logger(context);

  return {
    debug: (message) => logger.debug(message),
    info: (message) => logger.log(message),
    warn: (message) => logger.warn(message),
    error: (message) => logger.error(message),
  };
}
