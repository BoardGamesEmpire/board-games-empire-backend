import { PluginLoadRecorder } from '@bge/plugin';
import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';

const logger = new Logger('CoordinatorShutdown');

/**
 * The coordinator's app as its shutdown handlers see it: `close()` withdraws
 * the coordinator's plugin load records, then closes the app (#1083).
 *
 * `app.close()` on a Nest microservice stops its gRPC server first and runs
 * the shutdown hooks after, so the recorder's own hook would delete the
 * records only once the server is gone. For as long as the hooks take, a
 * gateway worker would read a ready record, dial the coordinator, fail and
 * count each failure against the plugin DataGateway. Withdrawn first, the
 * records tell the gateway worker the plugin is not loaded, and it refuses
 * the DataGateway instead of dialling.
 *
 * A withdrawal that fails is logged and the app still closes: the records go
 * stale on their own, and a process that won't stop is worse.
 */
export function withdrawLoadRecordsBeforeClose(
  app: Pick<INestApplicationContext, 'get' | 'close'>,
): Pick<INestApplicationContext, 'close'> {
  return {
    close: async () => {
      try {
        await app.get(PluginLoadRecorder).withdrawLoadRecords();
      } catch (err) {
        logger.error(
          `Failed to withdraw plugin load records before closing: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      await app.close();
    },
  };
}
