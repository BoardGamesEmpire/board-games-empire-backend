import { Action, PrismaClient, SystemRole } from '@bge/database';
import type { Logger } from '@nestjs/common';

/**
 * Initialize default roles and permissions
 */
export async function rolesAndPermissionsSeed(prisma: PrismaClient, logger: Logger) {
  // ============================================
  // PERMISSIONS
  // ============================================
  logger.log('📋 Creating permissions...');

  const permissionsToCreate = [
    // --- Global Admin/Owner ---
    { action: Action.Manage, subject: 'all', slug: 'manage:all', reason: 'Unrestricted access for Owner' },

    // --- App Level / User ---
    { action: Action.Read, subject: 'User', slug: 'read:user:profile', reason: 'View user profiles' },
    {
      action: Action.Update,
      subject: 'User',
      conditions: { id: '{{ user.id }}' },
      slug: 'update:user:profile:own',
      reason: 'Update own profile',
    },
    { action: Action.Read, subject: 'Game', slug: 'read:game', reason: 'View games' },
    { action: Action.Create, subject: 'Game', slug: 'create:game', reason: 'Create games' },
    { action: Action.Update, subject: 'Game', slug: 'update:game', reason: 'Update games' },
    { action: Action.Delete, subject: 'Game', slug: 'delete:game', reason: 'Delete games' },

    // Game Collection
    { action: Action.Read, subject: 'GameCollection', slug: 'read:game_collection', reason: 'View game collections' },
    {
      action: Action.Create,
      subject: 'GameCollection',
      slug: 'create:game_collection',
      reason: 'Add game to collection',
    },
    {
      action: Action.Update,
      subject: 'GameCollection',
      slug: 'update:game_collection',
      reason: 'Update game in collection',
    },
    {
      action: Action.Delete,
      subject: 'GameCollection',
      slug: 'delete:game_collection',
      reason: 'Remove game from collection',
    },

    // --- Households ---
    { action: Action.Create, subject: 'Household', slug: 'create:household', reason: 'Create a household' },
    { action: Action.Read, subject: 'Household', slug: 'read:household', reason: 'View a household' },
    { action: Action.Update, subject: 'Household', slug: 'update:household', reason: 'Update a household' },
    {
      action: Action.Delete,
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
      action: Action.Manage,
      subject: 'HouseholdMember',
      slug: 'manage:household_member',
      reason: 'Manage household members',
    },
    {
      action: Action.Create,
      subject: 'HouseholdRole',
      slug: 'create:household_role',
      reason: 'Create household roles',
    },
    {
      action: Action.Create,
      subject: 'HouseholdInvite',
      slug: 'create:household_invite',
      reason: 'Invite to household',
    },
    {
      action: Action.Create,
      subject: 'HouseholdMember',
      slug: 'create:household_member:join',
      reason: 'Join household',
    },

    // --- Events ---
    { action: Action.Create, subject: 'Event', slug: 'create:event', reason: 'Create an event' },
    { action: Action.Read, subject: 'Event', slug: 'read:event', reason: 'View an event' },
    { action: Action.Update, subject: 'Event', slug: 'update:event', reason: 'Update an event' },
    { action: Action.Delete, subject: 'Event', slug: 'delete:event', reason: 'Delete an event' },
    {
      action: Action.Update,
      subject: 'Event',
      fields: ['status'],
      conditions: { status: 'CANCELLED' },
      slug: 'update:event:status:cancel-event',
      reason: 'Cancel an event',
    },
    {
      action: Action.Update,
      subject: 'Event',
      fields: ['status'],
      conditions: { status: 'CANCELLED' },
      slug: 'update:event:status:archive-event',
      reason: 'Archive a cancelled event',
    },
    { action: Action.Create, subject: 'EventAttendee', slug: 'create:event_attendee:join', reason: 'Join an event' },
    { action: Action.Create, subject: 'EventInvite', slug: 'create:event_invite', reason: 'Invite to event' },
    {
      action: Action.Manage,
      subject: 'EventAttendee',
      slug: 'manage:event_attendee',
      reason: 'Manage event participants',
    },

    // --- Game Sessions ---
    { action: Action.Read, subject: 'GameSession', slug: 'read:game_session', reason: 'View a game session' },
    { action: Action.Create, subject: 'GameSession', slug: 'create:game_session', reason: 'Create a game session' },
    { action: Action.Update, subject: 'GameSession', slug: 'update:game_session', reason: 'Update a game session' },
    { action: Action.Delete, subject: 'GameSession', slug: 'delete:game_session', reason: 'Delete a game session' },
    {
      action: Action.Create,
      subject: 'GameSessionAttendee',
      slug: 'create:game_session_attendee:join',
      reason: 'Join a game session',
    },
    {
      action: Action.Create,
      subject: 'GameSessionAttendee',
      conditions: { role: 'OBSERVER' },
      slug: 'create:game_session_attendee:observer:join',
      reason: 'Join session as observer',
    },

    // --- Campaigns ---
    { action: Action.Create, subject: 'Campaign', slug: 'create:campaign', reason: 'Create campaign' },
    { action: Action.Update, subject: 'Campaign', slug: 'update:campaign', reason: 'Update campaign' },
    { action: Action.Delete, subject: 'Campaign', slug: 'delete:campaign', reason: 'Delete campaign' },
    {
      action: Action.Manage,
      subject: 'CampaignMember',
      slug: 'manage:campaign_member',
      reason: 'Manage campaign members',
    },

    // --- Rule Variants & Media ---
    { action: Action.Create, subject: 'RuleVariant', slug: 'create:rule_variant', reason: 'Create rule variant' },
    { action: Action.Update, subject: 'RuleVariant', slug: 'update:rule_variant', reason: 'Update rule variant' },
    { action: Action.Delete, subject: 'RuleVariant', slug: 'delete:rule_variant', reason: 'Delete rule variant' },
    { action: Action.Create, subject: 'Media', slug: 'create:media:upload', reason: 'Upload media' },

    // --- Customization ---
    {
      action: Action.Create,
      subject: 'UserGameCustomization',
      slug: 'create:user_game_customization',
      reason: 'Create customization',
    },
    {
      action: Action.Update,
      subject: 'UserGameCustomization',
      slug: 'update:user_game_customization',
      reason: 'Update customization',
    },
    {
      action: Action.Delete,
      subject: 'UserGameCustomization',
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
    const roleId = rolesByName[roleName].id;
    for (const slug of slugs) {
      if (!permissionsBySlug[slug]) {
        logger.warn(`Permission slug not found: ${slug}`);
        continue;
      }
      await prisma.rolePermission.upsert({
        where: {
          roleId_permissionId: {
            roleId,
            permissionId: permissionsBySlug[slug].id,
          },
        },
        update: {},
        create: {
          roleId,
          permissionId: permissionsBySlug[slug].id,
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
    'read:game_session',
    'read:event',
    'read:household',
    'read:public_content',
    'manage:content:moderate',
    'delete:event',
    'delete:game_session',
    'update:event',
  ]);

  // STANDARD USER
  await assignPermissions(SystemRole.User, [
    'read:user:profile',
    'update:user:profile:own',
    'create:game',
    'create:event',
    'create:campaign',
    'create:household',
    'create:rule_variant',
    'create:game_collection',
    'delete:game_collection',
    'update:game_collection',
    'read:game_collection',
    'create:user_game_customization',
    'update:user_game_customization',
    'delete:user_game_customization',
    'create:household_member:join',
    'create:event_attendee:join',
    'create:game_session_attendee:join',
    'read:public_content',
  ]);

  // HOUSEHOLD OWNER
  await assignPermissions(SystemRole.HouseholdOwner, [
    'read:household',
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
    'create:game_session',
    'update:game_session',
    'delete:game_session',
    'create:campaign',
    'update:campaign',
    'delete:campaign',
    'manage:campaign_member',
    'create:rule_variant',
    'update:rule_variant',
    'delete:rule_variant',
    'read:game_collection',
    'create:play_record',
  ]);

  // HOUSEHOLD ADMIN
  await assignPermissions(SystemRole.HouseholdAdmin, [
    'read:household',
    'update:household',
    'manage:household_member',
    'create:household_role',
    'create:household_invite',
    'create:event',
    'update:event',
    'manage:event_attendee',
    'create:event_invite',
    'create:game_session',
    'update:game_session',
    'create:campaign',
    'update:campaign',
    'manage:campaign_member',
    'create:rule_variant',
    'update:rule_variant',
    'create:play_record',
  ]);

  // HOUSEHOLD MEMBER
  await assignPermissions(SystemRole.HouseholdMember, [
    'read:household',
    'read:event',
    'create:event_attendee:join',
    'read:game_session',
    'create:game_session_attendee:join',
    'create:game_session',
    'create:play_record',
    'create:rule_variant',
    'read:game_collection',
  ]);

  // HOUSEHOLD GUEST
  await assignPermissions(SystemRole.HouseholdGuest, [
    'read:household',
    'read:event',
    'create:event_attendee:join',
    'read:game_session',
    'create:game_session_attendee:join',
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
    'create:game_session',
    'create:play_record',
    'read:game_session',
    'update:game_session',
    'delete:game_session',
  ]);

  // EVENT CO-HOST
  await assignPermissions(SystemRole.EventCoHost, [
    'read:event',
    'update:event',
    'update:event:status:cancel-event',
    'manage:event_attendee',
    'create:event_invite',
    'create:game_session',
    'create:play_record',
    'read:game_session',
    'update:game_session',
    'delete:game_session',
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
    'delete:game_session',
    'manage:event_attendee',
  ]);

  // EVENT PARTICIPANT
  await assignPermissions(SystemRole.EventParticipant, [
    'read:event',
    'create:event_attendee:join',
    'create:event_invite',
    'read:game_session',
    'create:game_session_attendee:join',
    'create:game_session',
    'update:game_session',
    'create:play_record',
    'create:rule_variant',
    'create:media:upload',
    'read:game_collection',
  ]);

  // EVENT GUEST
  await assignPermissions(SystemRole.EventGuest, [
    'read:event',
    'create:event_attendee:join',
    'read:game_session',
    'create:game_session_attendee:join',
  ]);

  // EVENT SPECTATOR
  await assignPermissions(SystemRole.EventSpectator, [
    'read:event',
    'create:game_session_attendee:observer:join',
    'read:game_session',
  ]);

  logger.log('✅ All permissions assigned.');
}
