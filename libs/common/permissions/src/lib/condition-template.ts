import * as Mustache from 'mustache';

/**
 * Why a condition template cannot be rendered safely. The `reason` strings are
 * the ones `PluginAbilityRenderRejectionError` carries, so the plugin path maps
 * a problem onto its rejection one-to-one, and the API key path (#266, #1417)
 * reads the same verdict.
 */
export type TemplateProblem =
  | { reason: 'out-of-context-variable'; variable: string }
  | { reason: 'malformed-template' }
  | { reason: 'unsupported-token-type'; tokenType: string };

/**
 * The fail-loud rule: every variable a condition template references must
 * resolve to a value in `context`. Mustache renders missing variables to `''`.
 * For user abilities that lands on a clause that matches nothing and is
 * accepted as an operator concern, but for a PLUGIN or an API key a malformed
 * clause like `{ userId: '' }` is an authorization boundary rendered wrong, so
 * the caller rejects the permission before any rendering happens.
 *
 * Returns the first problem found, or `null` when the template renders to what
 * it says. A passing check proves only that each variable is a non-empty
 * string: render contexts are meant for id-like leaves, since Mustache
 * HTML-escapes `{{ }}` output (a value with `&`, `<` or a quote comes out
 * changed) and a value with a backslash would break the JSON parse. The API
 * key path renders against the whole owner graph, so a template there should
 * name ids, as the catalog's do (#266).
 * Walks the parsed token tree: interpolations (`name`/`&`) and section
 * openers (`#`/`^`) all name variables, and section bodies are walked
 * recursively. The implicit iterator `.` never resolves (the context holds no
 * lists) and is reported as out-of-context.
 *
 * The parse is inside the contract too: a template that does not even parse
 * (an unclosed tag) can no more be rendered safely than one referencing
 * unknown variables, and must not escape as Mustache's raw Error (a 500
 * instead of the typed rejection).
 *
 * The token walk is a WHITELIST. Mustache token tuples are
 * `[type, name, start, end, subTokens?]`: `'text'` carries no variable,
 * `'name'`/`'&'` interpolate (triple-stache parses as `'&'`), and sections
 * `'#'`/`'^'` name a variable and nest their body at index 4. Anything else is
 * rejected outright rather than silently rendered: partials (`'>'`) and
 * comments (`'!'`) both render to the empty string, and delimiter changes
 * (`'='`) reshape parsing. That is not a variable problem, since `name` there
 * is a partial name or comment text, not a context path, so it gets its own
 * reason and the operator does not hunt for a variable that does not exist.
 */
export function findTemplateProblem(template: string, context: Record<string, unknown>): TemplateProblem | null {
  let tokens: Mustache.TemplateSpans;

  try {
    tokens = Mustache.parse(template);
  } catch {
    return { reason: 'malformed-template' };
  }

  return findTokenProblem(tokens, context);
}

/**
 * Renders a permission's conditions against `context`; `undefined` for null,
 * non-object, array or empty conditions, so the caller can treat the rule as
 * type-level. Throws nothing the caller hasn't checked: call
 * {@link findTemplateProblem} on the serialized conditions first, since a
 * variable the context lacks renders to `''` here without complaint. That
 * check passing proves only that each variable is a non-empty string, so the
 * context's leaves are meant to be id-like (see {@link findTemplateProblem}).
 */
export function renderPermissionConditions(
  conditions: unknown,
  context: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (conditions === null || typeof conditions !== 'object' || Array.isArray(conditions)) {
    return undefined;
  }

  if (Object.keys(conditions).length === 0) {
    return undefined;
  }

  // `conditions` is only read (serialized) here, so render it directly:
  // JSON.stringify never mutates, so no defensive clone is needed.
  const rendered = Mustache.render(JSON.stringify(conditions), context);

  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- the server's own rendered condition template, not outside data (#1322)
  return JSON.parse(rendered) as Record<string, unknown>;
}

function findTokenProblem(tokens: Mustache.TemplateSpans, context: Record<string, unknown>): TemplateProblem | null {
  for (const token of tokens) {
    const [type, name, , , subTokens] = token;

    if (type === 'text') {
      continue;
    }

    if (type === 'name' || type === '&' || type === '#' || type === '^') {
      if (!resolvesToString(name, context)) {
        return { reason: 'out-of-context-variable', variable: name };
      }

      if ((type === '#' || type === '^') && Array.isArray(subTokens)) {
        const nested = findTokenProblem(subTokens, context);

        if (nested) {
          return nested;
        }
      }

      continue;
    }

    return { reason: 'unsupported-token-type', tokenType: type };
  }

  return null;
}

/**
 * Own-property resolution to a non-empty STRING leaf, or it does not resolve.
 * Both halves are load-bearing: `in`-style lookup would admit prototype-chain
 * names (`unit.constructor` is "in" every object), and a non-leaf resolution
 * (`{{ unit }}`) would render `[object Object]` into the clause: junk, not
 * authority. Every legitimate context value is a non-empty string (ids, slugs,
 * the scope type). `.` never resolves, because the context holds no lists.
 */
function resolvesToString(path: string, context: Record<string, unknown>): boolean {
  if (path === '.') {
    return false;
  }

  let value: unknown = context;

  for (const segment of path.split('.')) {
    if (typeof value !== 'object' || value === null || !Object.prototype.hasOwnProperty.call(value, segment)) {
      return false;
    }

    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- TypeScript has no narrowing from `object` to an indexable record, and the own-property check above doesn't narrow a computed key (#1321)
    value = (value as Record<string, unknown>)[segment];
  }

  return typeof value === 'string' && value.length > 0;
}
