import { DatabaseService, Prisma } from '@bge/database';
import { Injectable, NotFoundException } from '@nestjs/common';

@Injectable()
export class LanguageService {
  constructor(private readonly db: DatabaseService) {}

  async getLanguages() {
    return this.db.language.findMany();
  }

  async getLanguageById(id: string) {
    try {
      return await this.db.language.findUniqueOrThrow({
        where: { id },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError) {
        throw new NotFoundException(`Language with id ${id} not found`);
      }

      throw error;
    }
  }
}
