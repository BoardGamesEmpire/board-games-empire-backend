import { DatabaseService, isPrismaDependentRecordNotFoundError } from '@bge/database';
import { t } from '@bge/i18n';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { LanguageQueryDto } from './dto/language-query.dto';

@Injectable()
export class LanguageService {
  constructor(private readonly db: DatabaseService) {}

  async getLanguages(languageDto: LanguageQueryDto) {
    const { limit = 20, offset = 0, ...filters } = languageDto;
    const actualLimit = Math.max(1, Math.min(limit, 50));

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
      take: actualLimit,
      skip: offset,
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
