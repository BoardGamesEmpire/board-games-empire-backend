import { DatabaseService, isPrismaDependentRecordNotFoundError } from '@bge/database';
import { t } from '@bge/i18n';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { LanguageQueryDto } from './dto/language-query.dto';

@Injectable()
export class LanguageService {
  constructor(private readonly db: DatabaseService) {}

  async getLanguages(languageDto: LanguageQueryDto) {
    const { skip, pageSize, ...filters } = languageDto;

    // systemSupported lives on LanguageTag: a language "is supported" when
    // any of its tags is.
    const supportedFilter =
      filters.systemSupported === undefined
        ? undefined
        : filters.systemSupported
          ? { some: { systemSupported: true } }
          : { none: { systemSupported: true } };

    return this.db.language.findMany({
      where: {
        name: filters.name ? { contains: filters.name, mode: 'insensitive' } : undefined,
        tags: supportedFilter,
      },
      include: { tags: { orderBy: { tag: 'asc' } } },
      // `Language.name` is `@unique`, so sorting by it is a total order; the
      // nested `tags` order above is unrelated to how the page is cut.
      orderBy: { name: 'asc' },
      take: pageSize,
      skip,
    });
  }

  async getLanguageById(id: string) {
    try {
      return await this.db.language.findUniqueOrThrow({
        where: { id },
        include: { tags: { orderBy: { tag: 'asc' } } },
      });
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new NotFoundException(t('errors.language.not_found', { id }));
      }

      throw error;
    }
  }
}
