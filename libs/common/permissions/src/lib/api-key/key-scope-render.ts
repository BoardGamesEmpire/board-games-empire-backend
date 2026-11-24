import type { TemplateProblem } from '../condition-template';
import { findTemplateProblem, renderPermissionConditions } from '../condition-template';
import type { HoldingContext } from './holding-contexts';

/** Why a key scope's conditions can't be built in a context: not an object, or a template problem (#266). */
export type KeyScopeRenderRefusal = { readonly reason: 'not-an-object' } | TemplateProblem;

/** A key scope's conditions rendered in one context, or why they can't be (#266). */
export type KeyScopeRender =
  { readonly conditions: Record<string, unknown> | undefined } | { readonly refusal: KeyScopeRenderRefusal };

/**
 * Why a key scope builds no allow in a holding context: the owner graph's copy
 * of the permission is a denial, or its conditions can't be built there (#266).
 */
export type HeldAllowRefusal = { readonly reason: 'denial' } | KeyScopeRenderRefusal;

/** An allow's conditions rendered in one holding context, or why it builds no allow there (#266, #1417). */
export type HeldAllowRender =
  { readonly conditions: Record<string, unknown> | undefined } | { readonly refusal: HeldAllowRefusal };

/**
 * Renders a key scope's conditions in one context (#266). Only null and `{}`
 * mean "no conditions" here. Conditions that aren't an object (a list, a
 * string, a number) can't be read as a bound, and a template naming a
 * variable the context lacks would render `''` into the clause, so both are
 * refused. No catalog row is either; this fails closed on a row written some
 * other way.
 */
export function renderKeyScopeConditions(conditions: unknown, context: Record<string, unknown>): KeyScopeRender {
  if (conditions === null || conditions === undefined) {
    return { conditions: undefined };
  }

  if (typeof conditions !== 'object' || Array.isArray(conditions)) {
    return { refusal: { reason: 'not-an-object' } };
  }

  const problem = Object.keys(conditions).length > 0 ? findTemplateProblem(JSON.stringify(conditions), context) : null;

  if (problem) {
    return { refusal: problem };
  }

  return { conditions: renderPermissionConditions(conditions, context) };
}

/**
 * Whether a key scope over `held.permission` builds an allow in `held`'s
 * context, and its rendered conditions when it does. The one buildability
 * decision both `AbilityFactory.createForApiKey` and the grantable rule read,
 * so the list a key's owner picks from and the rules the key gets agree on
 * which contexts build. The list alone also refuses a retired permission: the
 * loaders drop retired rows, so the factory meets one only in a stale cached
 * graph, where the owner's own ability still holds it too (#1417).
 *
 * The owner graph's copy can be flipped to a denial between the key's and the
 * owner's graph loads; a denial's conditions never build an allow (#266).
 */
export function renderHeldAllow(held: HoldingContext): HeldAllowRender {
  if (held.permission.inverted) {
    return { refusal: { reason: 'denial' } };
  }

  return renderKeyScopeConditions(held.permission.conditions, held.context);
}
