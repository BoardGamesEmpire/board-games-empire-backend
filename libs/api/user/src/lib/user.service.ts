import { DatabaseService } from '@bge/database';
import { Injectable } from '@nestjs/common';
import { UserSearchQueryDto } from './dto/user-search-query.dto';
import type { UserSearchResult } from './interfaces/user-search-results.interface';

@Injectable()
export class UserService {
  private readonly MAX_SEARCH_RESULTS = 20;

  constructor(private readonly db: DatabaseService) {}

  async findById(id: string) {
    return this.db.user.findUnique({ where: { id } });
  }

  async findByEmail(email: string) {
    return this.db.user.findUnique({ where: { email } });
  }

  async findByUsername(username: string) {
    return this.db.user.findUnique({ where: { username } });
  }

  async searchUsers(requestingUserId: string, query: UserSearchQueryDto): Promise<UserSearchResult[]> {
    const take = Math.min(query.limit, this.MAX_SEARCH_RESULTS);
    return this.db.user.findMany({
      where: {
        AND: [
          { banned: false },
          { id: { not: requestingUserId } },
          { profile: { isSearchable: true } },
          {
            OR: [
              { username: { contains: query.q, mode: 'insensitive' } },
              { firstName: { contains: query.q, mode: 'insensitive' } },
              { profile: { displayName: { contains: query.q, mode: 'insensitive' } } },
            ],
          },
        ],
      },
      select: {
        id: true,
        username: true,
        firstName: true,
        lastName: true,
        image: true,
        profile: {
          select: {
            displayName: true,
            avatarUrl: true,
          },
        },
      },
      take,
      skip: query.offset,
      orderBy: { username: 'asc' },
    });
  }
}
