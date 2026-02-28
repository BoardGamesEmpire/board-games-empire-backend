import type { Permission } from '@bge/database';
import { AbilityBuilder, ExtractSubjectType } from '@casl/ability';
import { createPrismaAbility } from '@casl/prisma';
import { Injectable } from '@nestjs/common';
import cloneDeep from 'lodash/cloneDeep';
import * as Mustache from 'mustache';
import type { ApikeyWithScopes, AppAbility, Subjects, UserWithRoles } from './interfaces';

@Injectable()
export class AbilityFactory {
  createForUser(userWithRoles: UserWithRoles): AppAbility {
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

    return ability.build();
  }

  createForApiKey(apiKey: ApikeyWithScopes): AppAbility {
    const ability = new AbilityBuilder<AppAbility>(createPrismaAbility);

    for (const scope of apiKey.scopes) {
      const access = scope.permission.inverted ? ability.cannot : ability.can;
      const { action, subject } = scope.permission;

      if (scope.resourceId) {
        access(action, subject as ExtractSubjectType<Subjects>, { id: scope.resourceId });
      } else {
        access(action, subject as ExtractSubjectType<Subjects>);
      }
    }

    return ability.build();
  }

  private parseConditions(
    permissions: Permission[],
    ability: AbilityBuilder<AppAbility>,
    context: Record<string, any>,
  ) {
    for (const permission of permissions) {
      let parsedConditions: Record<string, any> | undefined = undefined;

      if (permission.conditions) {
        const templated = cloneDeep(permission.conditions);
        const rendered = Mustache.render(JSON.stringify(templated), context);
        parsedConditions = JSON.parse(rendered);
      }

      const conditions = [permission.fields?.length ? permission.fields : undefined, parsedConditions].filter(Boolean);
      const access = permission.inverted ? ability.cannot : ability.can;
      access(permission.action, permission.subject as ExtractSubjectType<Subjects>, ...conditions);
    }
  }
}
