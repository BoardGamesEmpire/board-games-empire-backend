import type { Permission } from '@bge/database';
import { Action } from '@bge/database';
import { AbilityBuilder, ExtractSubjectType } from '@casl/ability';
import { createPrismaAbility } from '@casl/prisma';
import { Injectable, Logger } from '@nestjs/common';
import * as Mustache from 'mustache';
import type { ApikeyWithScopes, AppAbility, Subjects, UserWithRoles } from './interfaces';

@Injectable()
export class AbilityFactory {
  private readonly logger = new Logger(AbilityFactory.name);

  createForUser(userWithRoles: UserWithRoles | null): AppAbility {
    const ability = new AbilityBuilder<AppAbility>(createPrismaAbility);
    if (!userWithRoles) {
      return ability.build();
    }

    userWithRoles.roles.forEach((userRole) => {
      const permissions = userRole.role.permissions.map(({ permission }) => permission);
      this.parseConditions(permissions, ability, {
        user: userWithRoles,
        role: userRole.role.name,
      });
    });

    userWithRoles.householdMember.forEach((member) => {
      const permissions = member.role?.role?.permissions.map(({ permission }) => permission) || [];

      this.parseConditions(permissions, ability, {
        role: member.role?.role.name,
        user: userWithRoles,
        householdId: member.householdId,
      });
    });

    userWithRoles.eventsAttended.forEach((attendee) => {
      const permissions = attendee.role?.role?.permissions.map(({ permission }) => permission) || [];
      this.parseConditions(permissions, ability, {
        role: attendee.role?.role.name,
        user: userWithRoles,
        eventId: attendee.eventId,
      });
    });

    return ability.build({
      detectSubjectType: (object) => (object?.constructor?.name || object) as ExtractSubjectType<Subjects>,
    });
  }

  createForApiKey(apiKey: ApikeyWithScopes): AppAbility {
    const ability = new AbilityBuilder<AppAbility>(createPrismaAbility);

    for (const scope of apiKey.scopes) {
      const access = scope.permission.inverted ? ability.cannot : ability.can;
      const { action, subject } = scope.permission;

      if (scope.resourceId) {
        access.call(ability, action, subject as ExtractSubjectType<Subjects>, { id: scope.resourceId });
      } else {
        access.call(ability, action, subject as ExtractSubjectType<Subjects>);
      }
    }

    return ability.build();
  }

  /**
   * System actors carry no user and represent internal origins (migrations,
   * scheduled/recurring tasks, cascade jobs). They are granted `manage all`.
   *
   * `reason` is audit-only for now — it is logged but does not scope the ability.
   * Reason-gated scoping (restricting a system actor to a subset of resources
   * based on why it was minted) is a future refinement; the signature already
   * carries `reason` so callers do not change when that lands.
   */
  createForSystem(reason: string): AppAbility {
    this.logger.debug(`Building system ability (reason: ${reason})`);

    const ability = new AbilityBuilder<AppAbility>(createPrismaAbility);
    ability.can(Action.manage, 'all');

    return ability.build({
      detectSubjectType: (object) => (object?.constructor?.name || object) as ExtractSubjectType<Subjects>,
    });
  }

  private parseConditions(
    permissions: Permission[],
    ability: AbilityBuilder<AppAbility>,
    context: Record<string, any>,
  ) {
    for (const permission of permissions) {
      let parsedConditions: Record<string, any> | undefined = undefined;

      if (Object.keys(permission.conditions || {}).length > 0) {
        // `permission.conditions` is only read (serialized) here, so render it
        // directly — JSON.stringify never mutates, so no defensive clone is needed.
        const rendered = Mustache.render(JSON.stringify(permission.conditions), context);
        parsedConditions = JSON.parse(rendered);
      }

      const fields = permission.fields?.length ? permission.fields : undefined;
      const conditions = [fields, parsedConditions].filter(Boolean);

      const access: (action: Action, subject: Subjects, fields?: any, conditions?: any) => void = permission.inverted
        ? ability.cannot
        : ability.can;
      access.call(ability, permission.action, permission.subject as ExtractSubjectType<Subjects>, ...conditions);
    }
  }
}
