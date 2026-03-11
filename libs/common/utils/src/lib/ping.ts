import { GatewayPingResponse, GatewayServiceClient } from '@board-games-empire/proto-gateway';
import type { Logger } from '@nestjs/common';
import assert from 'node:assert';
import * as crypto from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { firstValueFrom } from 'rxjs';

export async function pingWithRetry(
  client: GatewayServiceClient,
  gatewayId: string,
  logger: Logger,
  maxAttempts = 5,
  baseDelayMs = 1000,
): Promise<GatewayPingResponse> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await firstValueFrom(client.ping({ correlationId: crypto.randomUUID() }));
    } catch (error) {
      assert(attempt < maxAttempts, error as Error);

      const delay = baseDelayMs * 2 ** (attempt - 1); // 1s, 2s, 4s, 8s
      logger.warn(`Gateway ${gatewayId} not ready (attempt ${attempt}/${maxAttempts}), retrying in ${delay}ms`);
      await setTimeout(delay);
    }
  }

  throw new Error(`Failed to ping gateway ${gatewayId} after ${maxAttempts} attempts`);
}
