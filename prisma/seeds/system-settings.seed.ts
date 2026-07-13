import type { PrismaClient } from '@bge/database';
import type { Logger } from '@nestjs/common';
import * as crypto from 'node:crypto';

export async function systemSettingsSeed(prisma: PrismaClient, logger: Logger) {
  logger.debug('Seeding system settings...');

  await prisma.systemSetting.upsert({
    where: { singleton: true },
    update: {},
    create: {
      identifier: crypto.randomUUID(),
      singleton: true,
      name: 'Board Games Empire',
      allowPasswordResets: true,
      allowUserRegistration: true,
      allowUsernameChange: true,
    },
  });
}
