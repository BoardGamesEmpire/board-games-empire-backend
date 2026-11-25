import type { Logger } from '@nestjs/common';

const MAX_LOGGED_NAMES = 100;
const LOG_WINDOW_MS = 60 * 60 * 1000;

export interface RefusalLogOptions {
  /** The line logged once the cap is reached, given the cap. */
  readonly capReached: (max: number) => string;

  readonly logger: Pick<Logger, 'warn'>;

  /** The line logged the first time a name is refused in the hour. */
  readonly refused: (name: string) => string;
}

/**
 * A log of what a check ahead of Nest refused, so an operator can see which
 * address or network to add (#977, #1511).
 *
 * It remembers each name once and stops at a cap, so someone sending endless
 * distinct names can't flood it or grow this set. It starts over each hour, so
 * outside traffic filling the cap can't hide a name the operator later needs.
 */
export function createRefusalLog({ capReached, logger, refused }: RefusalLogOptions): (name: string) => void {
  const loggedNames = new Set<string>();
  let capReported = false;
  let logWindowStart = Date.now();

  return (name) => {
    const now = Date.now();

    if (now - logWindowStart >= LOG_WINDOW_MS) {
      logWindowStart = now;
      loggedNames.clear();
      capReported = false;
    }

    if (loggedNames.has(name)) {
      return;
    }

    if (loggedNames.size < MAX_LOGGED_NAMES) {
      loggedNames.add(name);
      logger.warn(refused(name));
      return;
    }

    if (!capReported) {
      capReported = true;
      logger.warn(capReached(MAX_LOGGED_NAMES));
    }
  };
}
