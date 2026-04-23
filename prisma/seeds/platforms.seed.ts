import { PlatformType, type PrismaClient } from '@bge/database';
import type { Logger } from '@nestjs/common';

/**
 * Seeds system-owned Platform records.
 */
export async function platformsSeed(prisma: PrismaClient, logger: Logger) {
  const tabletop = await prisma.platform.upsert({
    where: { slug: 'tabletop' },
    create: {
      name: 'Tabletop',
      slug: 'tabletop',
      platformType: PlatformType.Tabletop,
      isSystem: true,
    },
    update: {
      name: 'Tabletop',
      platformType: PlatformType.Tabletop,
      isSystem: true,
    },
  });

  logger.log(`Seeded system platform: ${tabletop.name} (id=${tabletop.id})`);
}
