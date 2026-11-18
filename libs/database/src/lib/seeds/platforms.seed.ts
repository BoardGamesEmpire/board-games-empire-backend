import type { Logger } from '@nestjs/common';
import type { PrismaClient } from '../client';
import { PlatformType } from '../client';

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
