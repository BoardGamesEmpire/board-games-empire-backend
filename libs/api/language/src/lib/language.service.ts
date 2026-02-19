import { DatabaseService } from '@bge/database';
import { Injectable } from '@nestjs/common';

@Injectable()
export class LanguageService {
  constructor(private readonly db: DatabaseService) {}

  async getLanguages() {
    return this.db.language.findMany();
  }

  async getLanguageById(id: string) {
    return this.db.language.findUniqueOrThrow({
      where: { id },
    });
  }
}
