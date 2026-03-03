import { DatabaseService, SystemRole, Theme, User } from '@bge/database';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class UserProvisioningService {
  private readonly logger = new Logger(UserProvisioningService.name);

  constructor(private readonly db: DatabaseService) {}

  async provisionNewUser(user: User): Promise<void> {
    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`.trim()
      : user.username ?? user.email?.split('@')[0];

    // Determine role: first committed user becomes Owner, all others get User
    const usersCount = await this.db.user.count();
    const roleName = usersCount === 1 ? SystemRole.Owner : SystemRole.User;

    await this.db.$transaction(async (db) => {
      await db.userPreferences.create({
        data: {
          userId: user.id,
          theme: Theme.System,
          emailNotifications: {},
          pushNotifications: {},
        },
      });

      await db.userProfile.create({
        data: {
          userId: user.id,
          displayName,
        },
      });

      const role = await db.role.findUniqueOrThrow({
        where: { name: roleName },
        select: { id: true },
      });

      await db.userRole.create({
        data: {
          userId: user.id,
          roleId: role.id,
        },
      });
    });

    this.logger.debug(`Provisioned user ${user.id} with role '${roleName}'`);
  }
}
