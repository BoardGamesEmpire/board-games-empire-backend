import { Action, PrismaClient, SystemRole } from '@bge/database';
import type { Logger } from '@nestjs/common';

/**
 * Initialize default roles and permissions
 *
 * @todo refinements - these need work
 */
export async function rolesAndPermissionsSeed(prisma: PrismaClient, logger: Logger) {
  // ============================================
  // PERMISSIONS
  // ============================================
  logger.log('📋 Creating permissions...');

  const permissionsToCreate = [
    // --- Global Admin/Owner ---
    { action: Action.manage, subject: 'all', slug: 'manage:all', reason: 'Unrestricted access for Owner' },
    { action: Action.manage, subject: 'all', slug: 'manage:content:moderate', reason: 'Moderate app content' },
    { action: Action.read, subject: 'all', slug: 'read:public_content', reason: 'View public content' },

    // --- App Level / User ---
    // TODO: consider the ability to block other users from viewing your profile, etc.
    { action: Action.read, subject: 'UserProfile', slug: 'read:user:profile', reason: 'View user profiles' },
    {
      action: Action.update,
      subject: 'UserProfile',
      conditions: { id: '{{ user.id }}' },
      slug: 'update:user:profile:own',
      reason: 'Update own profile',
    },

    { action: Action.read, subject: 'Game', slug: 'read:game', reason: 'View games' },
    { action: Action.create, subject: 'Game', slug: 'create:game', reason: 'Create games' },

    // TODO: We should probably have conditions here to only allow updating/deleting games you created or that are in your collection, etc. Otherwise users could mess with each other's games.
    { action: Action.update, subject: 'Game', slug: 'update:game', reason: 'Update games' },
    { action: Action.delete, subject: 'Game', slug: 'delete:game', reason: 'Delete games' },

    // Game Collection
    { action: Action.read, subject: 'GameCollection', slug: 'read:game_collection', reason: 'View game collections' },
    {
      action: Action.create,
      subject: 'GameCollection',
      conditions: { userId: '{{ user.id }}' },
      slug: 'create:game_collection',
      reason: 'Add game to collection',
    },
    {
      action: Action.update,
      subject: 'GameCollection',
      conditions: { userId: '{{ user.id }}' },
      slug: 'update:game_collection',
      reason: 'Update game in collection',
    },
    {
      action: Action.delete,
      subject: 'GameCollection',
      conditions: { userId: '{{ user.id }}' },
      slug: 'delete:game_collection',
      reason: 'Remove game from collection',
    },

    // --- Game Gateway ---
    { action: Action.read, subject: 'GameGateway', slug: 'read:game_gateway', reason: 'View game gateway connections' },
    {
      action: Action.create,
      subject: 'GameGateway',
      slug: 'create:game_gateway',
      reason: 'Create game gateway connections',
    },
    {
      action: Action.update,
      subject: 'GameGateway',
      slug: 'update:game_gateway',
      reason: 'Update game gateway connections',
    },
    {
      action: Action.delete,
      subject: 'GameGateway',
      slug: 'delete:game_gateway',
      reason: 'Delete game gateway connections',
    },

    // --- Households ---
    { action: Action.create, subject: 'Household', slug: 'create:household', reason: 'Create a household' },
    {
      action: Action.read,
      subject: 'Household',
      conditions: {
        members: { some: { userId: '{{ user.id }}' } },
      },
      slug: 'read:households',
      reason: 'View households',
    },
    {
      action: Action.read,
      subject: 'Household',
      conditions: {
        id: '{{ householdId }}',
      },
      slug: 'read:household',
      reason: 'View household details',
    },

    // TODO: We should probably have more granular permissions here to allow for different levels of household management, etc. Otherwise, any member could update the household details
    {
      action: Action.update,
      subject: 'Household',
      conditions: {
        id: '{{ householdId }}',
        members: { some: { userId: '{{ user.id }}' } },
      },
      slug: 'update:household',
      reason: 'Update a household',
    },
    {
      action: Action.delete,
      subject: 'Household',
      conditions: {
        id: '{{ householdId }}',
        members: {
          some: {
            userId: '{{ user.id }}',
            role: { role: { name: 'HouseholdOwner' } },
          },
        },
      },
      slug: 'delete:household',
      reason: 'Delete a household',
    },
    {
      action: Action.manage,
      subject: 'HouseholdMember',
      conditions: {
        householdId: '{{ householdId }}',
        members: {
          some: {
            userId: '{{ user.id }}',
            role: { role: { name: { in: ['HouseholdOwner', 'HouseholdAdmin'] } } },
          },
        },
      },
      slug: 'manage:household_member',
      reason: 'Manage household members',
    },
    {
      action: Action.create,
      subject: 'HouseholdRole',
      conditions: {
        householdId: '{{ householdId }}',
        members: {
          some: {
            userId: '{{ user.id }}',
            role: { role: { name: { in: ['HouseholdOwner', 'HouseholdAdmin'] } } },
          },
        },
      },
      slug: 'create:household_role',
      reason: 'Create household roles',
    },

    // TODO: maybe defer to a household policy?
    {
      action: Action.create,
      subject: 'Invite',
      conditions: {
        householdId: '{{ householdId }}',
        members: {
          some: {
            userId: '{{ user.id }}',
            role: { role: { name: { in: ['HouseholdOwner', 'HouseholdAdmin'] } } },
          },
        },
      },
      slug: 'create:household_invite',
      reason: 'Invite to household',
    },

    // TODO: this is likely too simplistic
    {
      action: Action.create,
      subject: 'HouseholdMember',
      conditions: {
        householdId: '{{ householdId }}',
      },
      slug: 'create:household_member:join',
      reason: 'Join household',
    },

    // --- Events ---
    { action: Action.create, subject: 'Event', slug: 'create:event', reason: 'Create an event' },

    // TODO household specific event permissions? i.e read:household_event etc
    { action: Action.read, subject: 'Event', slug: 'read:event', reason: 'View an event' },
    {
      action: Action.update,
      subject: 'Event',
      conditions: {
        id: '{{ eventId }}',
        attendees: {
          some: {
            userId: '{{ user.id }}',
            role: { role: { name: { in: ['EventHost', 'EventCoHost', 'EventOrganizer', 'EventModerator'] } } },
          },
        },
      },
      slug: 'update:event',
      reason: 'Update an event',
    },
    {
      action: Action.delete,
      subject: 'Event',
      conditions: { createdById: '{{ user.id }}' },
      slug: 'delete:event',
      reason: 'Delete an event as creator',
    },

    // TODO: this needs conditions to validate moderator role and scope
    {
      action: Action.delete,
      subject: 'Event',
      slug: 'delete:event:moderate',
      reason: 'Delete any event as moderator',
    },

    // TODO: this doesn't actually ensure the event is being cancelled...
    {
      action: Action.update,
      subject: 'Event',
      fields: ['status'],
      conditions: {
        id: '{{ eventId }}',
        attendees: {
          some: {
            userId: '{{ user.id }}',
            role: { role: { name: { in: ['EventHost', 'EventCoHost'] } } },
          },
        },
      },
      slug: 'update:event:status:cancel-event',
      reason: 'Cancel an event',
    },

    // An event can be archived if it is cancelled and the user is the host
    {
      action: Action.update,
      subject: 'Event',
      fields: ['status'],
      conditions: {
        id: '{{ eventId }}',
        status: 'Cancelled',
        attendees: {
          some: {
            userId: '{{ user.id }}',
            role: { role: { name: 'EventHost' } },
          },
        },
      },
      slug: 'update:event:status:archive-event',
      reason: 'Archive a cancelled event',
    },
    {
      action: Action.create,
      subject: 'Invite',
      conditions: {
        eventId: '{{ eventId }}',
        event: {
          attendees: {
            some: {
              userId: '{{ user.id }}',
              role: { role: { name: { in: ['EventHost', 'EventCoHost', 'EventOrganizer', 'EventParticipant'] } } },
            },
          },
        },
      },
      slug: 'create:event_invite',
      reason: 'Invite to event',
    },
    {
      action: Action.manage,
      subject: 'EventAttendee',
      conditions: { eventId: '{{ eventId }}' },
      slug: 'manage:event_attendee',
      reason: 'Manage event participants',
    },

    // --- Game Sessions ---
    {
      action: Action.create,
      subject: 'GamePlayResult',
      slug: 'create:play_record',
      reason: 'Create a play record',
    },
    { action: Action.read, subject: 'GamePlaySession', slug: 'read:game_play_session', reason: 'View a game session' },
    {
      action: Action.create,
      subject: 'GamePlaySession',
      slug: 'create:game_play_session',
      reason: 'Create a game session',
    },
    {
      action: Action.update,
      subject: 'GamePlaySession',
      slug: 'update:game_play_session',
      reason: 'Update a game session',
    },
    {
      action: Action.delete,
      subject: 'GamePlaySession',
      slug: 'delete:game_play_session',
      reason: 'Delete a game session',
    },
    {
      action: Action.create,
      subject: 'SessionPlayer',
      slug: 'create:session_player:join',
      reason: 'Join a game session',
    },
    {
      action: Action.create,
      subject: 'SessionPlayer',
      slug: 'create:session_player:observer:join',
      reason: 'Join a game session as observer',
    },

    // --- Rule Variants ---
    { action: Action.create, subject: 'RuleVariant', slug: 'create:rule_variant', reason: 'Create rule variant' },
    {
      action: Action.update,
      subject: 'RuleVariant',
      conditions: {
        createdById: '{{ user.id }}',
      },
      slug: 'update:rule_variant',
      reason: 'Update rule variant',
    },
    {
      action: Action.delete,
      subject: 'RuleVariant',
      conditions: {
        createdById: '{{ user.id }}',
      },
      slug: 'delete:rule_variant',
      reason: 'Delete rule variant',
    },

    // --- Media ---
    // TODO: expand media permissions
    { action: Action.create, subject: 'Media', slug: 'create:media:upload', reason: 'Upload media' },

    // --- Customization ---
    {
      action: Action.create,
      subject: 'UserGameCustomization',
      slug: 'create:user_game_customization',
      reason: 'Create customization',
    },
    {
      action: Action.update,
      subject: 'UserGameCustomization',
      conditions: {
        userId: '{{ user.id }}',
      },
      slug: 'update:user_game_customization',
      reason: 'Update customization',
    },
    {
      action: Action.delete,
      subject: 'UserGameCustomization',
      conditions: {
        userId: '{{ user.id }}',
      },
      slug: 'delete:user_game_customization',
      reason: 'Delete customization',
    },
  ];

  const permissionsBySlug: Record<string, any> = {};
  for (const perm of permissionsToCreate) {
    const created = await prisma.permission.upsert({
      where: { slug: perm.slug },
      update: {
        action: perm.action,
        subject: perm.subject,
        fields: perm.fields || [],
        conditions: perm.conditions ? perm.conditions : {},
        reason: perm.reason,
      },
      create: {
        action: perm.action,
        subject: perm.subject,
        fields: perm.fields || [],
        conditions: perm.conditions ? perm.conditions : {},
        reason: perm.reason,
        slug: perm.slug,
      },
    });
    permissionsBySlug[perm.slug] = created;
  }
  logger.log(`✅ Default permissions created.`);

  // ============================================
  // SYSTEM ROLES
  // ============================================
  logger.log('📋 Creating roles...');

  const rolesToCreate = [
    // System
    { name: SystemRole.Owner, description: 'System owner with absolute control' },
    { name: SystemRole.Admin, description: 'Full access to all system functions' },
    { name: SystemRole.Moderator, description: 'Can moderate content but cannot change system settings' },
    { name: SystemRole.User, description: 'Standard user account' },

    // Household
    { name: SystemRole.HouseholdOwner, description: 'Owner of a household with full control' },
    { name: SystemRole.HouseholdAdmin, description: 'Can manage household settings and members' },
    { name: SystemRole.HouseholdMember, description: 'Regular household member' },
    { name: SystemRole.HouseholdGuest, description: 'Limited access household guest' },

    // Event
    { name: SystemRole.EventHost, description: 'Host of an event with permissions to manage it' },
    { name: SystemRole.EventCoHost, description: 'Co-Host of an event' },
    { name: SystemRole.EventOrganizer, description: 'Logistics focused, no moderation' },
    { name: SystemRole.EventModerator, description: 'Moderator scoped to an event' },
    { name: SystemRole.EventParticipant, description: 'Active participant in an event' },

    // is there are difference?
    { name: SystemRole.EventGuest, description: 'Limited access event guest' },
    { name: SystemRole.EventSpectator, description: 'Read-only observer for an event' },
  ];

  const rolesByName: Record<string, any> = {};
  for (const roleData of rolesToCreate) {
    const created = await prisma.role.upsert({
      where: { name: roleData.name },
      update: { description: roleData.description, isSystem: true },
      create: { name: roleData.name, description: roleData.description, isSystem: true },
    });
    rolesByName[roleData.name] = created;
  }
  logger.log('✅ Roles created.');

  // Helper to map permissions to roles
  const assignPermissions = async (roleName: string, slugs: string[]) => {
    const roleId: string = rolesByName[roleName].id;
    for (const slug of slugs) {
      const permission = permissionsBySlug[slug];
      if (!permission) {
        throw new Error(`Permission with slug ${slug} not found for role ${roleName}`);
      }

      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId,
            permissionId: permission.id,
          },
        },
        update: {},
        create: {
          roleId,
          permissionId: permission.id,
        },
      });
    }
  };

  logger.log('📋 Assigning permissions to roles...');

  // OWNER
  await assignPermissions(SystemRole.Owner, ['manage:all']);

  // ADMIN
  const allPermsExceptManageAll = permissionsToCreate.map((p) => p.slug).filter((s) => s !== 'manage:all');
  await assignPermissions(SystemRole.Admin, allPermsExceptManageAll);

  // MODERATOR
  await assignPermissions(SystemRole.Moderator, [
    'read:user:profile',
    'read:game_collection',
    'read:game_play_session',
    'read:event',
    'read:household',
    'read:households',
    'read:public_content',
    'manage:content:moderate',
    'delete:event:moderate',
    'delete:game_play_session',
    'update:event',
  ]);

  // STANDARD USER
  await assignPermissions(SystemRole.User, [
    'read:user:profile',
    'update:user:profile:own',
    'create:game',
    'create:event',
    'create:household',
    'read:households',
    'read:game_play_session',
    'create:rule_variant',
    'create:game_collection',
    'delete:game_collection',
    'update:game_collection',
    'read:game_collection',
    'create:user_game_customization',
    'update:user_game_customization',
    'delete:user_game_customization',
    'create:household_member:join',
    'create:session_player:join',
  ]);

  // HOUSEHOLD OWNER
  await assignPermissions(SystemRole.HouseholdOwner, [
    'read:household',
    'read:households',
    'update:household',
    'delete:household',
    'manage:household_member',
    'create:household_role',
    'create:household_invite',
    'create:event',
    'update:event',
    'delete:event',
    'manage:event_attendee',
    'create:event_invite',
    'create:game_play_session',
    'update:game_play_session',
    'delete:game_play_session',
    'create:rule_variant',
    'update:rule_variant',
    'delete:rule_variant',
    'read:game_collection',
    'create:play_record',
  ]);

  // HOUSEHOLD ADMIN
  await assignPermissions(SystemRole.HouseholdAdmin, [
    'read:household',
    'read:households',
    'update:household',
    'manage:household_member',
    'create:household_role',
    'create:household_invite',
    'create:event',
    'update:event',
    'manage:event_attendee',
    'create:event_invite',
    'create:game_play_session',
    'update:game_play_session',
    'create:rule_variant',
    'update:rule_variant',
    'create:play_record',
  ]);

  // HOUSEHOLD MEMBER
  await assignPermissions(SystemRole.HouseholdMember, [
    'read:household',
    'read:households',
    'read:event',
    'read:game_play_session',
    'create:session_player:join',
    'create:game_play_session',
    'create:play_record',
    'create:rule_variant',
    'read:game_collection',
  ]);

  // HOUSEHOLD GUEST
  await assignPermissions(SystemRole.HouseholdGuest, [
    'read:household',
    'read:households',
    'read:event',
    'read:game_play_session',
    'create:session_player:join',
  ]);

  // EVENT HOST
  await assignPermissions(SystemRole.EventHost, [
    'read:event',
    'update:event',
    'delete:event',
    'update:event:status:cancel-event',
    'update:event:status:archive-event',
    'manage:event_attendee',
    'create:event_invite',
    'create:game_play_session',
    'create:play_record',
    'read:game_play_session',
    'update:game_play_session',
    'delete:game_play_session',
  ]);

  // EVENT CO-HOST
  await assignPermissions(SystemRole.EventCoHost, [
    'read:event',
    'update:event',
    'update:event:status:cancel-event',
    'manage:event_attendee',
    'create:event_invite',
    'create:game_play_session',
    'create:play_record',
    'read:game_play_session',
    'update:game_play_session',
    'delete:game_play_session',
  ]);

  // EVENT ORGANIZER
  await assignPermissions(SystemRole.EventOrganizer, [
    'read:event',
    'update:event',
    'manage:event_attendee',
    'create:event_invite',
  ]);

  // EVENT MODERATOR
  await assignPermissions(SystemRole.EventModerator, [
    'read:event',
    'update:event',
    'delete:game_play_session',
    'manage:event_attendee',
  ]);

  // EVENT PARTICIPANT
  await assignPermissions(SystemRole.EventParticipant, [
    'read:event',
    'create:event_invite',
    'read:game_play_session',
    'create:session_player:join',
    'create:game_play_session',
    'update:game_play_session',
    'create:play_record',
    'create:rule_variant',
    'create:media:upload',
    'read:game_collection',
  ]);

  // EVENT GUEST
  await assignPermissions(SystemRole.EventGuest, [
    'read:event',
    'read:game_play_session',
    'create:session_player:join',
  ]);

  // EVENT SPECTATOR
  await assignPermissions(SystemRole.EventSpectator, [
    'read:event',
    'create:session_player:observer:join',
    'read:game_play_session',
  ]);

  logger.log('✅ All permissions assigned.');
}
