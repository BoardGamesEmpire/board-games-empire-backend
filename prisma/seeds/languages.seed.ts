import type { LanguageCreateInput, PrismaClient } from '@bge/database';
import ISO6391 from 'iso-639-1';
import { iso6393 } from 'iso-639-3';

export async function languagesSeed(prisma: PrismaClient) {
  // TODO: Expand language support
  const systemSupportedCodes = ['en'];

  const languages = iso6393
    .filter((language) => language.type === 'living')
    .filter((language) => language.scope === 'individual')
    .map<LanguageCreateInput>((lang) => {
      const iso6391 = lang.iso6391!;

      const language: LanguageCreateInput = {
        code: lang.iso6393,
        name: ISO6391.getName(iso6391) || lang.name,
        abbreviation: iso6391 || null,
        nativeName: ISO6391.getNativeName(iso6391) || null,
        systemSupported: systemSupportedCodes.includes(iso6391),
      };

      return language;
    });

  for (const language of languages) {
    await prisma.language.upsert({
      create: language,
      update: language,
      where: {
        code: language.code,
      },
    });
  }
}
