import { DatabaseService, isPrismaDependentRecordNotFoundError, Prisma } from '@bge/database';
import { t } from '@bge/i18n';
import type { PaginatedRows } from '@bge/shared';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { LanguageQueryDto } from './dto/language-query.dto';

type LanguageWithTags = Prisma.LanguageGetPayload<{ include: { tags: true } }>;

@Injectable()
export class LanguageService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * One page of languages plus the total matching the filters, for the response
   * envelope (#372). The count runs against the same `where` as the rows — a
   * filtered read whose `total` describes the unfiltered table tells a client
   * it has pages to fetch that are not there.
   */
  async getLanguages(languageDto: LanguageQueryDto): Promise<PaginatedRows<LanguageWithTags>> {
    const { skip, pageSize, ...filters } = languageDto;

    // systemSupported lives on LanguageTag: a language "is supported" when
    // any of its tags is.
    const supportedFilter =
      filters.systemSupported === undefined
        ? undefined
        : filters.systemSupported
          ? { some: { systemSupported: true } }
          : { none: { systemSupported: true } };

    const where: Prisma.LanguageWhereInput = {
      name: filters.name ? { contains: filters.name, mode: 'insensitive' } : undefined,
      tags: supportedFilter,
    };

    const [rows, total] = await this.db.$transaction(
      [
        this.db.language.findMany({
          where,
          include: { tags: { orderBy: { tag: 'asc' } } },
          // `Language.name` is `@unique`, so sorting by it is a total order; the
          // nested `tags` order above is unrelated to how the page is cut.
          orderBy: { name: 'asc' },
          take: pageSize,
          skip,
        }),

        this.db.language.count({ where }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    return { rows, total };
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
