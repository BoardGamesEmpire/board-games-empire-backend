import type { PrismaClient } from '@bge/database';
import type { Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';

/**
 * Seeds the singleton `SafeHttpPolicy` row. All field defaults live on the
 * Prisma model, so this seed only ensures the row exists; on a fresh install
 * the policy lands with `strictMode: true`, no allow/block entries, and the
 * standard SSRF deny rules in full effect.
 *
 * Subsequent runs are no-ops — `update: {}` guarantees admin edits are not
 * overwritten by seed re-runs.
 */
export async function safeHttpPolicySeed(prisma: PrismaClient, logger: Logger) {
  logger.debug('Seeding SafeHttp policy...');

  await prisma.safeHttpPolicy.upsert({
    where: { singleton: true },
    update: {},
    create: {
      identifier: crypto.randomUUID(),
      singleton: true,
    },
  });
}
