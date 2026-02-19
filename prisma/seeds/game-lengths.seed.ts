import type { PrismaClient } from '@bge/database';
import type { Logger } from '@nestjs/common';

export async function gameLengthsSeed(prisma: PrismaClient, logger: Logger) {
  const gameLengths = [
    {
      name: 'Filler',
      description: 'Ultra-quick games while waiting',
      minMinutes: 0,
      maxMinutes: 15,
      displayOrder: 1,
    },
    {
      name: 'Quick',
      description: 'Short and sweet',
      minMinutes: 15,
      maxMinutes: 30,
      displayOrder: 2,
    },
    {
      name: 'Short',
      description: 'Standard game length',
      minMinutes: 30,
      maxMinutes: 60,
      displayOrder: 3,
    },
    {
      name: 'Medium',
      description: 'A solid gaming session',
      minMinutes: 60,
      maxMinutes: 120,
      displayOrder: 4,
    },
    {
      name: 'Long',
      description: 'Dedicated evening game',
      minMinutes: 120,
      maxMinutes: 240,
      displayOrder: 5,
    },
    {
      name: 'Epic',
      description: 'Major time commitment',
      minMinutes: 240,
      maxMinutes: 480,
      displayOrder: 6,
    },
    {
      name: 'Marathon',
      description: 'All-day or multi-session campaigns',
      minMinutes: 480,
      maxMinutes: null, // Open-ended
      displayOrder: 7,
    },
  ];

  for (const length of gameLengths) {
    await prisma.gameLength.upsert({
      where: { name: length.name },
      create: length,
      update: length,
    });
  }

  logger.log('✅ Game lengths seeded');
}