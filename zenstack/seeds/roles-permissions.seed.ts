import { Permission, PrismaClient, SystemRole } from '@bge/database';
import type { Logger } from '@nestjs/common';

/**
 * Initialize default roles and permissions
 */
export async function rolesAndPermissionsSeed(prisma: PrismaClient, logger: Logger) {
  // ============================================
  // SYSTEM ROLES
  // ============================================

  const owner = await prisma.role.upsert({
    create: {
      name: SystemRole.Owner,
      description: 'System owner with absolute control',
      isSystem: true,
    },
    update: {},
    where: { name: SystemRole.Owner },
  });

  const adminRole = await prisma.role.upsert({
    create: {
      name: SystemRole.Admin,
      description: 'Full access to all system functions',
      isSystem: true,
    },
    update: {},
    where: { name: SystemRole.Admin },
  });

  const moderatorRole = await prisma.role.upsert({
    create: {
      name: SystemRole.Moderator,
      description: 'Can moderate content but cannot change system settings',
      isSystem: true,
    },
    update: {},
    where: { name: SystemRole.Moderator },
  });

  const userRole = await prisma.role.upsert({
    create: {
      name: SystemRole.User,
      description: 'Standard user account',
      isSystem: true,
    },
    update: {},
    where: { name: SystemRole.User },
  });

  // ============================================
  // HOUSEHOLD ROLES
  // ============================================

  const householdOwnerRole = await prisma.role.upsert({
    create: {
      name: SystemRole.HouseholdOwner,
      description: 'Owner of a household with full control',
      isSystem: true,
    },
    update: {},
    where: { name: SystemRole.HouseholdOwner },
  });

  const householdAdminRole = await prisma.role.upsert({
    create: {
      name: SystemRole.HouseholdAdmin,
      description: 'Can manage household settings and members',
      isSystem: true,
    },
    update: {},
    where: { name: SystemRole.HouseholdAdmin },
  });

  const householdMemberRole = await prisma.role.upsert({
    create: {
      name: SystemRole.HouseholdMember,
      description: 'Regular household member',
      isSystem: true,
    },
    update: {},
    where: { name: SystemRole.HouseholdMember },
  });

  const householdGuestRole = await prisma.role.upsert({
    create: {
      name: SystemRole.HouseholdGuest,
      description: 'Limited access household guest',
      isSystem: true,
    },
    update: {},
    where: { name: SystemRole.HouseholdGuest },
  });

  // ============================================
  // EVENT ROLES
  // ============================================

  const eventHostRole = await prisma.role.upsert({
    create: {
      name: SystemRole.EventHost,
      description: 'Host of an event with permissions to manage it',
      isSystem: true,
    },
    update: {},
    where: { name: SystemRole.EventHost },
  });

  const eventMemberRole = await prisma.role.upsert({
    create: {
      name: SystemRole.EventMember,
      description: 'Active participant in an event with contribution privileges',
      isSystem: true,
    },
    update: {},
    where: { name: SystemRole.EventMember },
  });

  const eventGuestRole = await prisma.role.upsert({
    create: {
      name: SystemRole.EventGuest,
      description: 'Limited access event guest',
      isSystem: true,
    },
    update: {},
    where: { name: SystemRole.EventGuest },
  });

  logger.log('✅ Roles created');

  const allPermissions = Object.values(Permission);

  // OWNER: Everything
  logger.log('📋 Assigning Owner permissions...');
  for (const permission of allPermissions) {
    await prisma.rolePermission.upsert({
      create: {
        roleId: owner.id,
        permission,
      },
      update: {},
      where: {
        roleId_permission: {
          roleId: owner.id,
          permission,
        },
      },
    });
  }

  // ADMIN: Everything except ownership transfer
  logger.log('📋 Assigning Admin permissions...');
  const adminPermissions = allPermissions.filter((perm) => perm !== Permission.TransferOwnership);
  for (const permission of adminPermissions) {
    await prisma.rolePermission.upsert({
      create: {
        roleId: adminRole.id,
        permission,
      },
      update: {},
      where: {
        roleId_permission: {
          roleId: adminRole.id,
          permission,
        },
      },
    });
  }

  // MODERATOR: Content moderation focused
  logger.log('📋 Assigning Moderator permissions...');
  const moderatorPermissions = [
    Permission.ViewUsers,
    Permission.ViewGameCollection,
    Permission.ViewGameSession,
    Permission.ViewEvent,
    Permission.ViewHousehold,
    Permission.ViewPublicContent,
    Permission.ModerateContent,
    Permission.DeleteEvent, // Can remove inappropriate events
    Permission.DeleteGameSession, // Can remove inappropriate sessions
    Permission.UpdateEvent, // Can edit event details if needed
  ];
  for (const permission of moderatorPermissions) {
    await prisma.rolePermission.upsert({
      create: {
        roleId: moderatorRole.id,
        permission,
      },
      update: {},
      where: {
        roleId_permission: {
          roleId: moderatorRole.id,
          permission,
        },
      },
    });
  }

  // STANDARD USER: Basic self-service permissions
  logger.log('📋 Assigning User permissions...');
  const standardUserPermissions = [
    // Profile
    Permission.ViewOwnProfile,
    Permission.UpdateOwnProfile,

    // Content creation
    Permission.CreateGame,
    Permission.CreateEvent,
    Permission.CreateCampaign,
    Permission.CreateHousehold,
    Permission.CreateRuleVariant,

    // Collection management
    Permission.AddGameToCollection,
    Permission.RemoveGameFromCollection,
    Permission.UpdateGameInCollection,
    Permission.ViewGameCollection,

    // Customization
    Permission.CreateUserGameCustomization,
    Permission.UpdateUserGameCustomization,
    Permission.DeleteUserGameCustomization,

    // Social
    Permission.JoinHousehold,
    Permission.JoinEvent,
    Permission.JoinGameSession,
    Permission.ViewPublicContent,

    // External data
    Permission.ImportGameFromExternalAPI,
  ];
  for (const permission of standardUserPermissions) {
    await prisma.rolePermission.upsert({
      create: {
        roleId: userRole.id,
        permission,
      },
      update: {},
      where: {
        roleId_permission: {
          roleId: userRole.id,
          permission,
        },
      },
    });
  }

  // HOUSEHOLD OWNER: Full household control
  logger.log('📋 Assigning Household Owner permissions...');
  const householdOwnerPermissions = [
    Permission.ViewHousehold,
    Permission.UpdateHousehold,
    Permission.DeleteHousehold,
    Permission.ManageHouseholdMembers,
    Permission.CreateHouseholdRoles,
    Permission.InviteToHousehold,
    Permission.CreateEvent,
    Permission.UpdateEvent,
    Permission.DeleteEvent,
    Permission.ManageEventParticipants,
    Permission.InviteToEvent,
    Permission.CreateGameSession,
    Permission.UpdateGameSession,
    Permission.DeleteGameSession,
    Permission.CreateCampaign,
    Permission.UpdateCampaign,
    Permission.DeleteCampaign,
    Permission.ManageCampaignMembers,
    Permission.CreateRuleVariant,
    Permission.UpdateRuleVariant,
    Permission.DeleteRuleVariant,
    Permission.ShareGameWithHousehold,
    Permission.ViewGameCollection,
    Permission.RecordGamePlay,
  ];
  for (const permission of householdOwnerPermissions) {
    await prisma.rolePermission.upsert({
      create: {
        roleId: householdOwnerRole.id,
        permission,
      },
      update: {},
      where: {
        roleId_permission: {
          roleId: householdOwnerRole.id,
          permission,
        },
      },
    });
  }

  // HOUSEHOLD ADMIN: Household management without deletion
  logger.log('📋 Assigning Household Admin permissions...');
  const householdAdminPermissions = [
    Permission.ViewHousehold,
    Permission.UpdateHousehold,
    Permission.ManageHouseholdMembers,
    Permission.CreateHouseholdRoles,
    Permission.InviteToHousehold,
    Permission.CreateEvent,
    Permission.UpdateEvent,
    Permission.ManageEventParticipants,
    Permission.InviteToEvent,
    Permission.CreateGameSession,
    Permission.UpdateGameSession,
    Permission.CreateCampaign,
    Permission.UpdateCampaign,
    Permission.ManageCampaignMembers,
    Permission.CreateRuleVariant,
    Permission.UpdateRuleVariant,
    Permission.RecordGamePlay,
  ];
  for (const permission of householdAdminPermissions) {
    await prisma.rolePermission.upsert({
      create: {
        roleId: householdAdminRole.id,
        permission,
      },
      update: {},
      where: {
        roleId_permission: {
          roleId: householdAdminRole.id,
          permission,
        },
      },
    });
  }

  // HOUSEHOLD MEMBER: Participation focused
  logger.log('📋 Assigning Household Member permissions...');
  const householdMemberPermissions = [
    Permission.ViewHousehold,
    Permission.ViewEvent,
    Permission.JoinEvent,
    Permission.ViewGameSession,
    Permission.JoinGameSession,
    Permission.CreateGameSession, // Can create sessions
    Permission.RecordGamePlay,
    Permission.CreateRuleVariant, // Can propose house rules
    Permission.ViewGameCollection,
  ];
  for (const permission of householdMemberPermissions) {
    await prisma.rolePermission.upsert({
      create: {
        roleId: householdMemberRole.id,
        permission,
      },
      update: {},
      where: {
        roleId_permission: {
          roleId: householdMemberRole.id,
          permission,
        },
      },
    });
  }

  // HOUSEHOLD GUEST: View-only with participation
  logger.log('📋 Assigning Household Guest permissions...');
  const householdGuestPermissions = [
    Permission.ViewHousehold,
    Permission.ViewEvent,
    Permission.JoinEvent, // Can join if invited
    Permission.ViewGameSession,
    Permission.JoinGameSession,
  ];
  for (const permission of householdGuestPermissions) {
    await prisma.rolePermission.upsert({
      create: {
        roleId: householdGuestRole.id,
        permission,
      },
      update: {},
      where: {
        roleId_permission: {
          roleId: householdGuestRole.id,
          permission,
        },
      },
    });
  }

  // EVENT HOST: Event-specific management
  logger.log('📋 Assigning Event Host permissions...');
  const eventHostPermissions = [
    Permission.ViewEvent,
    Permission.UpdateEvent,
    Permission.DeleteEvent,
    Permission.ManageEventParticipants,
    Permission.InviteToEvent,
    Permission.CreateGameSession,
    Permission.RecordGamePlay,
  ];
  for (const permission of eventHostPermissions) {
    await prisma.rolePermission.upsert({
      create: {
        roleId: eventHostRole.id,
        permission,
      },
      update: {},
      where: {
        roleId_permission: {
          roleId: eventHostRole.id,
          permission,
        },
      },
    });
  }

  // EVENT MEMBER: Active participation with contributions
  logger.log('📋 Assigning Event Member permissions...');
  const eventMemberPermissions = [
    Permission.ViewEvent,
    Permission.UpdateEvent,
    Permission.JoinEvent,
    Permission.InviteToEvent,
    Permission.ViewGameSession,
    Permission.JoinGameSession,
    Permission.CreateGameSession,
    Permission.UpdateGameSession,
    Permission.RecordGamePlay,
    Permission.ManageEventParticipants,
    Permission.CreateRuleVariant,
    Permission.UploadMedia,
    Permission.ViewGameCollection,
  ];
  for (const permission of eventMemberPermissions) {
    await prisma.rolePermission.upsert({
      create: {
        roleId: eventMemberRole.id,
        permission,
      },
      update: {},
      where: {
        roleId_permission: {
          roleId: eventMemberRole.id,
          permission,
        },
      },
    });
  }

  // EVENT GUEST: Participation only
  logger.log('📋 Assigning Event Guest permissions...');
  const eventGuestPermissions = [
    Permission.ViewEvent,
    Permission.JoinEvent,
    Permission.ViewGameSession,
    Permission.JoinGameSession,
  ];
  for (const permission of eventGuestPermissions) {
    await prisma.rolePermission.upsert({
      create: {
        roleId: eventGuestRole.id,
        permission,
      },
      update: {},
      where: {
        roleId_permission: {
          roleId: eventGuestRole.id,
          permission,
        },
      },
    });
  }

  logger.log('✅ All permissions assigned');
}
