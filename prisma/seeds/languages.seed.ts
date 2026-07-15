import type { PrismaClient } from '@bge/database';
import { displayName, nativeDisplayName, parseTag } from '@bge/locale';
import type { Logger } from '@nestjs/common';

// TODO: Expand i18n support
const systemSupportedTags = ['en'];

interface CuratedLanguage {
  iso6393: string;
  iso6391: string;

  // Canonical BCP 47 tags to seed; the first entry is the language's bare
  // tag. Extra entries are the script/region variants game releases
  // genuinely distinguish (zh-Hans vs zh-Hant, pt-PT vs pt-BR).
  tags: string[];
}

/**
 * Curated core vocabulary — the union of the IGDB and BGG gateway language
 * registries (~40 languages board/video games actually ship in), replacing
 * the old 7,000-row ISO 639-3 sweep. Display names, native names, and
 * script/region decomposition come from ICU at seed time.
 *
 * Gateways can extend this vocabulary at runtime through the capabilities
 * interview (see LanguageGatewayLink and its auto-add policy).
 */
const curatedLanguages: CuratedLanguage[] = [
  { iso6393: 'afr', iso6391: 'af', tags: ['af'] },
  { iso6393: 'ara', iso6391: 'ar', tags: ['ar'] },
  { iso6393: 'bul', iso6391: 'bg', tags: ['bg'] },
  { iso6393: 'cat', iso6391: 'ca', tags: ['ca'] },
  { iso6393: 'ces', iso6391: 'cs', tags: ['cs'] },
  { iso6393: 'dan', iso6391: 'da', tags: ['da'] },
  { iso6393: 'deu', iso6391: 'de', tags: ['de'] },
  { iso6393: 'ell', iso6391: 'el', tags: ['el'] },
  { iso6393: 'eng', iso6391: 'en', tags: ['en', 'en-US', 'en-GB'] },
  { iso6393: 'est', iso6391: 'et', tags: ['et'] },
  { iso6393: 'fin', iso6391: 'fi', tags: ['fi'] },
  { iso6393: 'fra', iso6391: 'fr', tags: ['fr'] },
  { iso6393: 'heb', iso6391: 'he', tags: ['he'] },
  { iso6393: 'hrv', iso6391: 'hr', tags: ['hr'] },
  { iso6393: 'hun', iso6391: 'hu', tags: ['hu'] },
  { iso6393: 'ind', iso6391: 'id', tags: ['id'] },
  { iso6393: 'ita', iso6391: 'it', tags: ['it'] },
  { iso6393: 'jpn', iso6391: 'ja', tags: ['ja'] },
  { iso6393: 'kor', iso6391: 'ko', tags: ['ko'] },
  { iso6393: 'lav', iso6391: 'lv', tags: ['lv'] },
  { iso6393: 'lit', iso6391: 'lt', tags: ['lt'] },
  { iso6393: 'nld', iso6391: 'nl', tags: ['nl'] },
  { iso6393: 'nor', iso6391: 'no', tags: ['no', 'nb'] },
  { iso6393: 'pol', iso6391: 'pl', tags: ['pl'] },
  { iso6393: 'por', iso6391: 'pt', tags: ['pt', 'pt-PT', 'pt-BR'] },
  { iso6393: 'ron', iso6391: 'ro', tags: ['ro'] },
  { iso6393: 'rus', iso6391: 'ru', tags: ['ru'] },
  { iso6393: 'slk', iso6391: 'sk', tags: ['sk'] },
  { iso6393: 'slv', iso6391: 'sl', tags: ['sl'] },
  { iso6393: 'spa', iso6391: 'es', tags: ['es', 'es-ES', 'es-MX'] },
  { iso6393: 'srp', iso6391: 'sr', tags: ['sr'] },
  { iso6393: 'swe', iso6391: 'sv', tags: ['sv'] },
  { iso6393: 'tha', iso6391: 'th', tags: ['th'] },
  { iso6393: 'tur', iso6391: 'tr', tags: ['tr'] },
  { iso6393: 'ukr', iso6391: 'uk', tags: ['uk'] },
  { iso6393: 'vie', iso6391: 'vi', tags: ['vi'] },
  { iso6393: 'zho', iso6391: 'zh', tags: ['zh', 'zh-Hans', 'zh-Hant'] },
];

export async function languagesSeed(prisma: PrismaClient, logger: Logger) {
  logger.log('Starting languages seed...');

  let tagCount = 0;

  for (const curated of curatedLanguages) {
    const bareTag = curated.tags[0];
    const name = displayName(bareTag);
    if (!name) {
      throw new Error(`languagesSeed: ICU has no display name for curated tag '${bareTag}'`);
    }

    const nativeName = nativeDisplayName(bareTag);
    const language = await prisma.language.upsert({
      where: { iso6393: curated.iso6393 },
      create: {
        iso6393: curated.iso6393,
        iso6391: curated.iso6391,
        name,
        nativeName,
      },
      update: { iso6391: curated.iso6391, name, nativeName },
      select: { id: true },
    });

    for (const tag of curated.tags) {
      const parsed = parseTag(tag);
      const tagName = displayName(tag);
      if (!parsed || !tagName) {
        throw new Error(`languagesSeed: curated tag '${tag}' is not a valid BCP 47 tag`);
      }

      const tagData = {
        script: parsed.script ?? null,
        region: parsed.region ?? null,
        name: tagName,
        nativeName: nativeDisplayName(tag),
        systemSupported: systemSupportedTags.includes(parsed.tag),
        languageId: language.id,
      };

      // source is written on update too: a tag first auto-added by a gateway
      // (source = Gateway) that later enters the curated list is authoritative
      // Curated vocabulary and must be reclassified on re-seed.
      await prisma.languageTag.upsert({
        where: { tag: parsed.tag },
        create: { tag: parsed.tag, source: 'Curated', ...tagData },
        update: { source: 'Curated', ...tagData },
      });

      tagCount++;
    }
  }

  logger.log(`Seeded ${curatedLanguages.length} languages with ${tagCount} tags.`);
}
