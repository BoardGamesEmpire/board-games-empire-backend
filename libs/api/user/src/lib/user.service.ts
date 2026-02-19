import { DatabaseService } from '@bge/database';
import { Injectable } from '@nestjs/common';

@Injectable()
export class UserService {
  constructor(private readonly db: DatabaseService) {}

  async findById(id: string) {
    return this.db.user.findUnique({
      where: { id },
    });
  }

  async findByEmail(email: string) {
    return this.db.user.findUnique({
      where: { email },
    });
  }

  async findByUsername(username: string) {
    return this.db.user.findUnique({
      where: { username },
    });
  }
}
