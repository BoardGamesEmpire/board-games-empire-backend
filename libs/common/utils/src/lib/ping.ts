import type { GatewayPingResponse, GatewayServiceClient } from '@boardgamesempire/proto-gateway';
import type { Logger } from '@nestjs/common';
import assert from 'node:assert';
import * as crypto from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { firstValueFrom } from 'rxjs';

/**
 * Pings a gateway until it answers, with backoff between tries.
 *
 * `shouldRetry` says whether an error is worth another try; by default every
 * error is. An error it refuses is thrown at once, unchanged. A caller whose
 * ping makes the other side do work it counts, as the gateway worker's ping
 * of the coordinator can, retries only while the other side can't be reached
 * (#1083).
 */
export async function pingWithRetry(
  client: GatewayServiceClient,
  gatewayId: string,
  logger: Logger,
  maxAttempts = 5,
  baseDelayMs = 1000,
  shouldRetry: (error: unknown) => boolean = () => true,
): Promise<GatewayPingResponse> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await firstValueFrom(client.ping({ correlationId: crypto.randomUUID() }));
    } catch (error) {
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- assert's message takes `string | Error`, and a catch binding is `unknown`; this rethrows the client's rejection as it is (#1321)
      assert(attempt < maxAttempts && shouldRetry(error), error as Error);

      const delay = baseDelayMs * 2 ** (attempt - 1); // 1s, 2s, 4s, 8s
      logger.warn(`Gateway ${gatewayId} not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`);
      await setTimeout(delay);
    }
  }

  throw new Error(`Failed to ping gateway ${gatewayId} after ${maxAttempts} attempts`);
}
