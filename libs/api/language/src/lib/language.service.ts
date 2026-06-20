import { DatabaseService, isPrismaDependentRecordNotFoundError } from '@bge/database';
import { Injectable, NotFoundException } from '@nestjs/common';
import type { LanguageQueryDto } from './dto/language-query.dto';

@Injectable()
export class LanguageService {
  constructor(private readonly db: DatabaseService) {}

  async getLanguages(languageDto: LanguageQueryDto) {
    const { limit = 20, offset = 0, ...filters } = languageDto;
    const actualLimit = Math.max(1, Math.min(limit, 50));

    return this.db.language.findMany({
      where: {
        name: filters.name ? { contains: filters.name, mode: 'insensitive' } : undefined,
        systemSupported: filters.systemSupported,
      },
      take: actualLimit,
      skip: offset,
    });
  }

  async getLanguageById(id: string) {
    try {
      return await this.db.language.findUniqueOrThrow({
        where: { id },
      });
    } catch (error) {
      if (isPrismaDependentRecordNotFoundError(error)) {
        throw new NotFoundException(`Language with id ${id} not found`);
      }

      throw error;
    }
  }
}
