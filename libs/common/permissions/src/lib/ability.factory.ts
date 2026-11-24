import { clonePluginUnit } from '@bge/actor-context';
import type { Permission } from '@bge/database';
import { Action } from '@bge/database';
import { parsePluginPermissionSlug, pluginPermissionCaslSubject } from '@boardgamesempire/plugin-manifest';
import { AbilityBuilder, detectSubjectType, ExtractSubjectType } from '@casl/ability';
import { createPrismaAbility } from '@casl/prisma';
import { Injectable, Logger } from '@nestjs/common';
import * as Mustache from 'mustache';
import { findTemplateProblem } from './condition-template';
import { PluginAbilityRenderRejectionError } from './errors/plugin-ability-render-rejection.error';
import type {
  ApikeyWithScopes,
  AppAbility,
  PluginGrantSnapshot,
  Subjects,
  UserPermissionWithPermission,
  UserWithRoles,
} from './interfaces';

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

/**
 * Subject detection shared by every `build(...)` in this factory: model
 * instances resolve by constructor name, plain values pass through. One
 * definition so the ability variants cannot drift on how a subject is
 * classified.
 *
 * `subject()`-TAGGED plain objects resolve by their tag — the edge instance
 * checks (#322: "may THIS household be addressed?") build their subjects
 * that way, because a plain object's constructor is `Object`, which matches
 * no rule and would silently deny. CASL's own detector serves the tag
 * lookup, but it is NOT total: it returns `constructor.modelName || name`
 * for every untagged object and dereferences `constructor` unguarded, so a
 * null-prototype object would turn a deny into a TypeError, and an
 * anonymous class's `''` would swallow the passthrough. The guards keep
 * this detector total exactly as the constructor-name original was:
 * degenerate inputs (a null prototype, a shadowed `constructor: null`) fall
 * through to the original passthrough — CASL's typed string-or-class
 * refusal — never a TypeError from inside detection.
 */
const detectAppSubjectType = (object: unknown) => {
  const detected =
    object !== null && typeof object === 'object' && object.constructor != null
      ? // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- CASL's detector takes a record, and TypeScript has no narrowing from `object` to one (#1321)
        detectSubjectType(object as Record<string, unknown>)
      : undefined;

  if (typeof detected === 'string' && detected.length > 0) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- CASL's detector returns a plain string, which names a Subjects member only by the app's model naming (#1321)
    return detected as ExtractSubjectType<Subjects>;
  }

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the passthrough hands CASL a constructor name or the value itself, for CASL to refuse when it names no subject; neither is typed as a Subjects member (#1321)
  return ((object as { constructor?: { name?: string } })?.constructor?.name || object) as ExtractSubjectType<Subjects>;
};

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

    return ability.build({ detectSubjectType: detectAppSubjectType });
  }

  /**
   * The abilities of an actor acting through an API key: the key owner's,
   * then the key's own, which every check and query ANDs, so access is the
   * floor of the two. A request through the key and a webhook subscription
   * made through it are judged by the same pair (#723), so a change to how a
   * key clamps its owner belongs here.
   */
  createForApiKeyActor(owner: AppAbility, apiKey: ApikeyWithScopes): [AppAbility, AppAbility] {
    return [owner, this.createForApiKey(apiKey)];
  }

  /**
   * An API key's own ability, which `PoliciesGuard` and the ceilings AND with
   * its owner's. Each scope becomes one rule, pinned to `resourceId` when it
   * names one. The permission's conditions are dropped (#266), so the owner's
   * ability bounds the rows.
   *
   * An allow keeps its grant's field list, so a check that names a field sees
   * the slug's reach. Without it, a staff member's key holding only
   * `read:plugin:installed` passed the server plugin reads' column gate on its
   * owner's say. A denial is kept whole: CASL skips a field-bound denial on any
   * check that names no field, and almost none does, so bound to its fields the
   * denial would stop denying.
   */
  createForApiKey(apiKey: ApikeyWithScopes): AppAbility {
    const ability = new AbilityBuilder<AppAbility>(createPrismaAbility);

    for (const scope of apiKey.scopes) {
      const { action, subject, inverted, fields } = scope.permission;
      const access: RuleApplier = inverted ? ability.cannot : ability.can;
      const fieldList = !inverted && fields?.length ? fields : undefined;
      const pin = scope.resourceId ? { id: scope.resourceId } : undefined;

      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Prisma types a Permission's subject as a plain string; the Permission catalog keeps it to Subjects names (#1321)
      access.call(ability, action, subject as ExtractSubjectType<Subjects>, ...[fieldList, pin].filter(Boolean));
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

    return ability.build({ detectSubjectType: detectAppSubjectType });
  }

  /**
   * A no-rule ability: denies every action on every subject. For callers
   * that must resolve SOMETHING for an actor with no resolvable authority —
   * the dangling plugin actor being the current case — without forging a
   * snapshot-shaped input to do it.
   */
  createDenyAll(): AppAbility {
    return new AbilityBuilder<AppAbility>(createPrismaAbility).build({ detectSubjectType: detectAppSubjectType });
  }

  /**
   * Plugin ability (#60): the granted set for the operating consent unit,
   * exactly as resolved by `PermissionsService.getPluginGrantSnapshot` —
   * never intersected with a triggering user.
   *
   * - A non-servable unit produces a NO-RULE ability (denies everything):
   *   the quiet-denial half of the plugin read path, kept here so every
   *   caller of the snapshot gets the policy without re-implementing it.
   * - Core grants render their condition templates against the
   *   unit-coordinate context `{ plugin: { id, slug }, unit: { scopeType,
   *   householdId?, userId? } }` — and FAIL LOUD (typed rejection, never a
   *   silently-empty render) when a template references anything outside
   *   it. See {@link PluginAbilityRenderRejectionError} for why.
   * - Own-namespace grants become `(verb, enveloped subject)` rules parsed
   *   deterministically from the canonical slug; a slug naming another
   *   plugin's namespace is corrupted state and rejects.
   */
  createForPlugin(snapshot: PluginGrantSnapshot): AppAbility {
    const ability = new AbilityBuilder<AppAbility>(createPrismaAbility);

    if (!snapshot.servable) {
      return ability.build({ detectSubjectType: detectAppSubjectType });
    }

    // clonePluginUnit is doing double duty here: the same owned-coordinates
    // copy every boundary uses is what makes key-PRESENCE the thing the
    // fail-loud walk checks (an absent coordinate is an absent key).
    const context = {
      plugin: { id: snapshot.plugin.id, slug: snapshot.plugin.slug },
      unit: clonePluginUnit(snapshot.unit),
    };

    for (const permission of snapshot.corePermissions) {
      let parsedConditions: Record<string, unknown> | undefined = undefined;

      if (Object.keys(permission.conditions || {}).length > 0) {
        const template = JSON.stringify(permission.conditions);
        this.assertTemplateWithinContext(template, context, permission.slug, snapshot);
        parsedConditions = JSON.parse(Mustache.render(template, context));
      }

      this.applyRule(ability, permission, parsedConditions);
    }

    for (const slug of snapshot.ownGrantSlugs) {
      // The parse itself is part of the typed contract: a `plugin|`-prefixed
      // slug that is not a canonical form is the same corruption class as a
      // foreign namespace, and must not escape as a raw RangeError (a 500 /
      // a retried job instead of the intended 403).
      let parsed: ReturnType<typeof parsePluginPermissionSlug>;
      try {
        parsed = parsePluginPermissionSlug(slug);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new PluginAbilityRenderRejectionError({
            reason: 'malformed-slug',
            pluginId: snapshot.plugin.id,
            pluginSlug: snapshot.plugin.slug,
            permissionSlug: slug,
            unit: snapshot.unit,
          });
        }

        throw error;
      }

      if (parsed.pluginSlug !== snapshot.plugin.slug) {
        throw new PluginAbilityRenderRejectionError({
          reason: 'foreign-namespace-slug',
          pluginId: snapshot.plugin.id,
          pluginSlug: snapshot.plugin.slug,
          permissionSlug: slug,
          unit: snapshot.unit,
        });
      }

      // The verb set is pinned to the Action enum values (manifest constants
      // doc + drift spec), so the cast converts nominally, not lossily.
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the manifest's verb union and Prisma's Action enum are separate types with the same values, and a plugin subject is a string CASL matches by name (#1321)
      ability.can(parsed.action as Action, pluginPermissionCaslSubject(parsed) as ExtractSubjectType<Subjects>);
    }

    return ability.build({ detectSubjectType: detectAppSubjectType });
  }

  /**
   * The one place a permission triple becomes a CASL rule: fields honored,
   * `inverted` selects can/cannot. Shared by the user-role path
   * ({@link parseConditions}) and the plugin path ({@link createForPlugin}),
   * whose only legitimate difference is WHAT happens before rendering, not
   * how a rendered rule is applied.
   */
  private applyRule(
    ability: AbilityBuilder<AppAbility>,
    rule: Pick<Permission, 'action' | 'subject' | 'inverted'> & { fields?: Permission['fields'] },
    parsedConditions: Record<string, unknown> | undefined,
  ): void {
    const fields = rule.fields?.length ? rule.fields : undefined;
    const conditions = [fields, parsedConditions].filter(Boolean);

    const access: RuleApplier = rule.inverted ? ability.cannot : ability.can;
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Prisma types a Permission's subject as a plain string; the Permission catalog keeps it to Subjects names (#1321)
    access.call(ability, rule.action, rule.subject as ExtractSubjectType<Subjects>, ...conditions);
  }

  /**
   * The plugin path's fail-loud rule: a condition template that names anything
   * outside the unit-coordinate context rejects the permission before any
   * rendering. The check itself is {@link findTemplateProblem}, shared with the
   * API key path; this maps its verdict onto the typed rejection.
   */
  private assertTemplateWithinContext(
    template: string,
    context: Record<string, unknown>,
    permissionSlug: string,
    snapshot: PluginGrantSnapshot,
  ): void {
    const problem = findTemplateProblem(template, context);

    if (problem) {
      throw new PluginAbilityRenderRejectionError({
        ...problem,
        pluginId: snapshot.plugin.id,
        pluginSlug: snapshot.plugin.slug,
        permissionSlug,
        unit: snapshot.unit,
      });
    }
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

      this.applyRule(ability, permission, parsedConditions);
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
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the server's own rendered condition template, not outside data (#1322)
    return JSON.parse(rendered) as Record<string, unknown>;
  }
}
