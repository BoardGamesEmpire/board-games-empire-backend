import { DatabaseService, SystemRole, Theme, User } from '@bge/database';
import { ServiceAccountService } from '@bge/services';
import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class UserProvisioningService {
  private readonly logger = new Logger(UserProvisioningService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly serviceAccount: ServiceAccountService,
  ) {}

  async provisionNewUser(user: User & { name?: string }): Promise<void> {
    const displayName = user.firstName
      ? `${user.firstName}${user.lastName ? ` ${user.lastName}` : ''}`.trim()
      : ((user.name || user.username) ?? user.email?.split('@')[0]);

    // First *human* becomes Owner. Service accounts are real User rows, so they
    // must be excluded or they'd shift the first human off Owner.
    const usersCount = await this.db.user.count({ where: { isServiceAccount: false } });
    const roleName = usersCount === 1 ? SystemRole.Owner : SystemRole.User;

    await this.db.$transaction(async (db) => {
      await db.userPreferences.create({
        data: { userId: user.id, theme: Theme.System, emailNotifications: {}, pushNotifications: {} },
      });
      await db.userProfile.create({ data: { userId: user.id, displayName } });

      const role = await db.role.findUniqueOrThrow({ where: { name: roleName }, select: { id: true } });
      await db.userRole.create({ data: { userId: user.id, roleId: role.id } });

      if (roleName === SystemRole.Owner) {
        await db.user.update({
          where: { id: user.id },
          data: { role: SystemRole.Admin.toLowerCase(), emailVerified: true },
        });
      }
    });

    if (roleName === SystemRole.Owner) {
      // System birth: the first Owner gets the system its service principal.
      // Idempotent, so re-provisioning or a future wizard is harmless.
      await this.serviceAccount.ensure();
    }

    this.logger.debug(`Provisioned user ${user.id} with role '${roleName}'`);
  }
}
