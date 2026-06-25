import type { Permission } from '@bge/database';
import { Action } from '@bge/database';
import { AbilityBuilder, ExtractSubjectType } from '@casl/ability';
import { createPrismaAbility } from '@casl/prisma';
import { Injectable, Logger } from '@nestjs/common';
import * as Mustache from 'mustache';
import type { ApikeyWithScopes, AppAbility, Subjects, UserPermissionWithPermission, UserWithRoles } from './interfaces';

/**
 * Applies a single CASL rule. Conditions are built dynamically from JSON and the
 * subject is resolved at runtime, so the strongly-typed `ability.can`/`ability.cannot`
 * signatures cannot describe them statically — this narrowed alias is the boundary
 * (an `unknown` bridge, never `any`). CASL distinguishes the `fields` argument from
 * the `conditions` argument by runtime type (array vs. object), so the call sites
 * keep arity minimal.
 */
type RuleApplier = (
  action: Action,
  subject: ExtractSubjectType<Subjects>,
  conditionsOrFields?: string[] | Record<string, unknown>,
  conditions?: Record<string, unknown>,
) => void;

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

    // Direct user permissions are applied last so they take precedence over
    // role-derived rules (CASL last-rule-wins). `?? []` defends against graphs
    // cached before the `permissions` field existed.
    this.applyUserPermissions(userWithRoles.permissions ?? [], ability, userWithRoles);

    return ability.build({
      detectSubjectType: (object) => (object?.constructor?.name || object) as ExtractSubjectType<Subjects>,
    });
  }

  createForApiKey(apiKey: ApikeyWithScopes): AppAbility {
    const ability = new AbilityBuilder<AppAbility>(createPrismaAbility);

    for (const scope of apiKey.scopes) {
      const access: RuleApplier = scope.permission.inverted ? ability.cannot : ability.can;
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
    context: Record<string, unknown>,
  ) {
    for (const permission of permissions) {
      let parsedConditions: Record<string, unknown> | undefined = undefined;

      if (Object.keys(permission.conditions || {}).length > 0) {
        // `permission.conditions` is only read (serialized) here, so render it
        // directly — JSON.stringify never mutates, so no defensive clone is needed.
        const rendered = Mustache.render(JSON.stringify(permission.conditions), context);
        parsedConditions = JSON.parse(rendered);
      }

      const fields = permission.fields?.length ? permission.fields : undefined;
      const conditions = [fields, parsedConditions].filter(Boolean);

      const access: RuleApplier = permission.inverted ? ability.cannot : ability.can;
      access.call(ability, permission.action, permission.subject as ExtractSubjectType<Subjects>, ...conditions);
    }
  }

  /**
   * Applies direct `UserPermission` grants/denials on top of the role-derived
   * rules. Within this (already-last) block, grants are emitted before denials so
   * a denial wins any contradiction that slips past assignment-time conflict
   * checks (deny-wins).
   *
   * A row is skipped when:
   * - the underlying `Permission.subject` is the `'all'` wildcard (wildcard
   *   authority is role-gated only), or
   * - it is expired (defense-in-depth — the loader already excludes expired rows,
   *   but a cached graph may outlive a row's `expiresAt`).
   *
   * The CASL subject is the row's `resourceType`. When a `resourceId` is present the
   * rule is pinned to that instance via `{ ...rendered, id: resourceId }`; otherwise
   * the rendered (user-context) conditions stand alone. `fields` are honored. The
   * rule's polarity is `UserPermission.inverted` when set (`true`/`false`), otherwise
   * the base `Permission.inverted` is inherited (`null` override).
   *
   * Conditions are rendered against a user-only context, so a permission whose
   * template references role/household/event variables renders to a clause that
   * matches nothing — an inert grant or a no-op denial. This is accepted: which
   * permissions are safe to assign directly is an operator decision, not a
   * factory concern.
   */
  private applyUserPermissions(
    userPermissions: UserPermissionWithPermission[],
    ability: AbilityBuilder<AppAbility>,
    user: UserWithRoles,
  ): void {
    const now = Date.now();
    const active = userPermissions.filter((up) => {
      if (up.expiresAt === null) {
        return true;
      }
      // The user graph round-trips through Redis (Keyv/Valkey), where Date values
      // deserialize to ISO strings on a cache hit; normalize before comparing.
      return new Date(up.expiresAt).getTime() > now;
    });

    // `UserPermission.inverted` overrides the base permission's polarity; `null`
    // inherits it. Grants first, denials last → a denial wins any same-target
    // contradiction.
    const isDenial = (up: UserPermissionWithPermission): boolean => up.inverted ?? up.permission.inverted;
    const ordered = [...active.filter((up) => !isDenial(up)), ...active.filter(isDenial)];

    for (const userPermission of ordered) {
      const { permission, resourceType, resourceId } = userPermission;

      // The 'all' wildcard is never directly assignable — wildcard authority is
      // role-gated only.
      if (permission.subject === 'all') {
        continue;
      }

      const rendered = this.renderConditions(permission.conditions, user);
      const conditions = resourceId ? { ...(rendered ?? {}), id: resourceId } : rendered;
      const fields = permission.fields?.length ? permission.fields : undefined;

      const access: RuleApplier = isDenial(userPermission) ? ability.cannot : ability.can;
      if (fields) {
        access.call(ability, permission.action, resourceType, fields, conditions);
      } else {
        access.call(ability, permission.action, resourceType, conditions);
      }
    }
  }

  /**
   * Renders a permission's templated conditions against a user-only context
   * (`{ user }` is the sole variable available outside a role/household/event
   * scope). Returns `undefined` for empty or non-object conditions so the caller
   * can treat the rule as type-level.
   */
  private renderConditions(
    conditions: Permission['conditions'],
    user: UserWithRoles,
  ): Record<string, unknown> | undefined {
    if (conditions === null || typeof conditions !== 'object' || Array.isArray(conditions)) {
      return undefined;
    }

    if (Object.keys(conditions).length === 0) {
      return undefined;
    }

    const rendered = Mustache.render(JSON.stringify(conditions), { user });
    return JSON.parse(rendered) as Record<string, unknown>;
  }
}
