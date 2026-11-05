import type { PlatformType, PrismaClient } from '@bge/database';

/**
 * The seeded Tabletop platform, which the sweep keeps, so a test can hold a
 * game on it without arranging a platform first. It is read rather than
 * written into the test, so a change to the seed fails here, at the lookup.
 *
 * Extracted when six suites each looked it up for themselves (#1070), on the
 * concrete-first rule `./wire.ts` describes.
 */
export function tabletopPlatform(
  prisma: PrismaClient,
): Promise<{ readonly id: string; readonly platformType: PlatformType }> {
  return prisma.platform.findUniqueOrThrow({ where: { slug: 'tabletop' }, select: { id: true, platformType: true } });
}
