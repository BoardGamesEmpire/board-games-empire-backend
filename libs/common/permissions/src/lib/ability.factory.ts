import { clonePluginUnit } from '@bge/actor-context';
import type { Permission } from '@bge/database';
import { Action } from '@bge/database';
import { parsePluginPermissionSlug, pluginPermissionCaslSubject } from '@boardgamesempire/plugin-manifest';
import { AbilityBuilder, detectSubjectType, ExtractSubjectType } from '@casl/ability';
import { createPrismaAbility } from '@casl/prisma';
import { Injectable, Logger } from '@nestjs/common';
import * as Mustache from 'mustache';
import type { HoldingContext } from './api-key/holding-contexts';
import {
  buildsDirectPermissionRule,
  holdingContexts,
  isDirectPermissionDenial,
  ownerContexts,
} from './api-key/holding-contexts';
import type { TemplateProblem } from './condition-template';
import { findTemplateProblem, renderPermissionConditions } from './condition-template';
import { PluginAbilityRenderRejectionError } from './errors/plugin-ability-render-rejection.error';
import type {
  ApiKeyScopeWithPermission,
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
   *
   * Both are built from the one owner graph (#266). A caller that already
   * holds the owner's ability passes it as `ownerAbility`, so the owner half
   * is that ability and not a rebuilt one. A key whose owner is gone has no
   * context to render a key scope in, so its own ability denies everything.
   */
  createForApiKeyActor(
    owner: UserWithRoles | null,
    apiKey: ApikeyWithScopes,
    ownerAbility?: AppAbility,
  ): [AppAbility, AppAbility] {
    const ownerHalf = ownerAbility ?? this.createForUser(owner);

    if (!owner) {
      return [ownerHalf, this.createDenyAll()];
    }

    return [ownerHalf, this.createForApiKey(owner, apiKey)];
  }

  /**
   * An API key's own ability, which `PoliciesGuard` and the ceilings AND with
   * its owner's. A key scope keeps its permission's conditions (#266),
   * rendered in each context where `owner` holds the permission
   * ({@link holdingContexts}): one rule per server role, household
   * membership, event attendance or direct permission that gives it to the
   * owner, each rendered with the context the owner's own rule renders with
   * there, but more strictly than the owner's rule (below). Which permissions
   * a key holds is fixed when it is made; which households and events they
   * reach follows the owner's graph as it loads now.
   *
   * A pin is ANDed with the rendered conditions, never spread into them: some
   * conditions name `id` themselves (`update:household` binds `id` to the
   * household), and a spread pin would replace the household instead of
   * narrowing it. A direct permission's own pin is ANDed the same way.
   *
   * An allow that can't be built in a context is left out there, and the key
   * keeps its other rules: its condition names a variable that context lacks,
   * or its conditions aren't an object. The owner's own rules apply both in
   * some form (an empty string, a field list or no conditions), so this is
   * where a key's rule and its owner's part. An allow that builds in no
   * context at all is logged as a warning. An owner who no longer holds the
   * permission gets no rule, which is not an error.
   *
   * A denial only narrows, so it renders in every context the owner has
   * ({@link ownerContexts}), held or not. Dropping a denial would widen the
   * key, so one that renders in no context denies the whole key. Denials are
   * applied after every allow, so a denial wins.
   *
   * An allow keeps its grant's field list, so a check that names a field sees
   * the slug's reach. Without it, a staff member's key holding only
   * `read:plugin:installed` passed the server plugin reads' column gate on its
   * owner's say. A denial is kept whole: CASL skips a field-bound denial on any
   * check that names no field, and almost none does, so bound to its fields the
   * denial would stop denying.
   */
  createForApiKey(owner: UserWithRoles, apiKey: ApikeyWithScopes): AppAbility {
    const ability = new AbilityBuilder<AppAbility>(createPrismaAbility);

    for (const scope of apiKey.scopes.filter(({ permission }) => !permission.inverted)) {
      this.applyApiKeyAllow(ability, owner, apiKey, scope);
    }

    for (const scope of apiKey.scopes.filter(({ permission }) => permission.inverted)) {
      if (!this.applyApiKeyDenial(ability, owner, scope)) {
        this.logger.warn(
          `API key ${apiKey.id}: its denial over permission ${scope.permissionId} renders in none of its owner's ` +
            `contexts, so the key denies everything (#266)`,
        );

        return this.createDenyAll();
      }
    }

    return ability.build({ detectSubjectType: detectAppSubjectType });
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
        // Rendered inline, not through `renderPermissionConditions`, so the plugin
        // path handles any conditions shape exactly as before: that helper reads a
        // non-object as "no conditions", and only the key path refuses one (#266).
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
   * ({@link parseConditions}), the plugin path ({@link createForPlugin}) and
   * the API key path ({@link createForApiKey}), whose only legitimate
   * difference is WHAT happens before rendering, not how a rendered rule is
   * applied.
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
   * One allow key scope, as one rule per context where `owner` holds its
   * permission, each the owner's own rule there with the key scope's pin
   * ANDed on (#266). A context the rule can't be built in is left out, and
   * the key keeps its other rules. One warning names every context tried when
   * the scope builds nowhere; when it builds somewhere, the contexts it
   * skipped are logged at debug level, since the key still reaches what the
   * owner holds.
   */
  private applyApiKeyAllow(
    ability: AbilityBuilder<AppAbility>,
    owner: UserWithRoles,
    apiKey: ApikeyWithScopes,
    scope: ApiKeyScopeWithPermission,
  ): void {
    const skipped: string[] = [];
    let built = false;

    for (const held of holdingContexts(owner, scope.permissionId)) {
      const { action, conditions, fields, inverted } = held.permission;

      // The owner graph's copy can be flipped between the two graph loads; a
      // denial's conditions must never build a `can` (#266).
      if (inverted) {
        continue;
      }

      const render = renderKeyScopeConditions(conditions, held.context);

      if ('unbuildable' in render) {
        skipped.push(`${describeContext(held)}, because the permission's conditions ${render.unbuildable}`);

        continue;
      }

      this.applyRule(
        ability,
        { action, subject: held.subject, inverted: false, fields },
        allOf([render.conditions, pinOf(held.resourceId), pinOf(scope.resourceId)]),
      );
      built = true;
    }

    if (skipped.length === 0) {
      return;
    }

    if (built) {
      this.logger.debug(
        `API key ${apiKey.id}: its key scope over permission ${scope.permissionId} builds no rule in ` +
          `${skipped.join('; ')} (#266)`,
      );

      return;
    }

    this.logger.warn(
      `API key ${apiKey.id}: leaving out its key scope over permission ${scope.permissionId}, which builds no rule ` +
        `in any context where its owner holds it: ${skipped.join('; ')} (#266)`,
    );
  }

  /**
   * One key scope over a denial, as one `cannot` per context the owner has,
   * held or not, with the key scope's pin ANDed on and no field list (#266).
   * Returns whether it rendered anywhere: the caller denies the whole key
   * when it didn't, since dropping a denial would widen the key.
   */
  private applyApiKeyDenial(
    ability: AbilityBuilder<AppAbility>,
    owner: UserWithRoles,
    scope: ApiKeyScopeWithPermission,
  ): boolean {
    const { action, subject, conditions } = scope.permission;
    let rendered = false;

    for (const context of ownerContexts(owner)) {
      const render = renderKeyScopeConditions(conditions, context);

      if ('unbuildable' in render) {
        continue;
      }

      this.applyRule(
        ability,
        { action, subject, inverted: true },
        allOf([render.conditions, denialPinOf(scope.resourceId)]),
      );
      rendered = true;
    }

    return rendered;
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
    // The one predicate `holdingContexts` asks too, so an API key's rule never
    // borrows a direct permission its owner's own ability leaves out (#266).
    const now = Date.now();
    const building = userPermissions.filter((up) => buildsDirectPermissionRule(up, now));

    // Grants first, denials last → a denial wins any same-target contradiction.
    const ordered = [
      ...building.filter((up) => !isDirectPermissionDenial(up)),
      ...building.filter(isDirectPermissionDenial),
    ];

    for (const userPermission of ordered) {
      const { permission, resourceType, resourceId } = userPermission;

      // `{ user }` is the sole variable available outside a role, household or
      // event scope.
      const rendered = renderPermissionConditions(permission.conditions, { user });
      const conditions = resourceId ? { ...(rendered ?? {}), id: resourceId } : rendered;
      const fields = permission.fields?.length ? permission.fields : undefined;

      const access: RuleApplier = isDirectPermissionDenial(userPermission) ? ability.cannot : ability.can;
      if (fields) {
        access.call(ability, permission.action, resourceType, fields, conditions);
      } else {
        access.call(ability, permission.action, resourceType, conditions);
      }
    }
  }
}

/** A key scope's conditions rendered in one context, or why they can't be (#266). */
type KeyScopeRender = { readonly conditions: Record<string, unknown> | undefined } | { readonly unbuildable: string };

/**
 * Renders a key scope's conditions in one context (#266). Only null and `{}`
 * mean "no conditions" here. Conditions that aren't an object (a list, a
 * string, a number) can't be read as a bound, and a template naming a
 * variable the context lacks would render `''` into the clause, so both come
 * back unbuildable, with the reason worded for the log line. No catalog row is
 * either; this fails closed on a row written some other way.
 */
function renderKeyScopeConditions(conditions: unknown, context: Record<string, unknown>): KeyScopeRender {
  if (conditions === null || conditions === undefined) {
    return { conditions: undefined };
  }

  if (typeof conditions !== 'object' || Array.isArray(conditions)) {
    return { unbuildable: "aren't an object" };
  }

  const problem = Object.keys(conditions).length > 0 ? findTemplateProblem(JSON.stringify(conditions), context) : null;

  if (problem) {
    return { unbuildable: describeTemplateProblem(problem) };
  }

  return { conditions: renderPermissionConditions(conditions, context) };
}

function describeTemplateProblem(problem: TemplateProblem): string {
  switch (problem.reason) {
    case 'out-of-context-variable':
      return `name {{ ${problem.variable} }}, which that context doesn't supply`;
    case 'malformed-template':
      return "don't parse as a template";
    case 'unsupported-token-type':
      return `use a '${problem.tokenType}' template tag, which conditions don't support`;
  }
}

/** A blank pin (`''`) still pins: `{ id: '' }` matches no row, so it fails closed (#266). */
function pinOf(resourceId: string | null | undefined): Record<string, unknown> | undefined {
  return resourceId != null ? { id: resourceId } : undefined;
}

/**
 * A denial's pin. Failing closed runs the other way for a denial: `{ id: '' }`
 * would deny no row, so a blank pin denies the whole subject instead (#266).
 */
function denialPinOf(resourceId: string | null | undefined): Record<string, unknown> | undefined {
  return resourceId ? { id: resourceId } : undefined;
}

/** Names where the owner holds a permission, for the log line of a dropped key scope (#266). */
function describeContext({ source, context }: HoldingContext): string {
  switch (source) {
    case 'serverRole':
      return `the owner's server role ${String(context['role'])}`;
    case 'household':
      return `the owner's household membership (householdId ${String(context['householdId'])})`;
    case 'event':
      return `the owner's event attendance (eventId ${String(context['eventId'])})`;
    case 'directPermission':
      return "the owner's direct permission";
  }
}

/**
 * ANDs a key's rule parts: its rendered conditions and any pins. One part
 * stands alone, as the role path passes its rendered conditions. Two or more
 * go under `AND`, so a pin narrows a condition that names `id` instead of
 * replacing it (#266).
 */
function allOf(parts: (Record<string, unknown> | undefined)[]): Record<string, unknown> | undefined {
  const present = parts.filter((part): part is Record<string, unknown> => part !== undefined);

  return present.length > 1 ? { AND: present } : present[0];
}
