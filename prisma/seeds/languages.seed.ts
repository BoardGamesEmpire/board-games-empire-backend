import type { PrismaClient } from '@bge/database';

export async function languagesSeed(prisma: PrismaClient) {
  // TODO: Expand language support
  const languages = [
    {
      name: 'English',
      abbreviation: 'en',
      code: 'eng',
    },
  ];

  for (const language of languages) {
    await prisma.language.upsert({
      create: language,
      update: language,
      where: {
        abbreviation: language.abbreviation,
      },
    });
  }
}
