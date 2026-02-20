import type { PrismaClient } from '@bge/database';
import type { Logger } from '@nestjs/common';

export async function systemSettingsSeed(prisma: PrismaClient, logger: Logger) {
  logger.debug('Seeding system settings...');

  await prisma.systemSetting.upsert({
    where: { singleton: true },
    update: {},
    create: {
      singleton: true,
      allowPasswordResets: true,
      allowUserRegistration: true,
      allowUsernameChange: true,
    },
  });
}
