import { findTemplateProblem, renderPermissionConditions } from './condition-template';

describe('findTemplateProblem (#266, #1417)', () => {
  const context = { user: { id: 'u1' } };

  it('returns null when every variable resolves to a string leaf', () => {
    expect(findTemplateProblem('{"a":"{{ user.id }}"}', context)).toBeNull();
  });

  it('returns null for a template that names no variable', () => {
    expect(findTemplateProblem('{"a":"fixed"}', context)).toBeNull();
  });

  it('reports a variable the context does not hold', () => {
    expect(findTemplateProblem('{"a":"{{ householdId }}"}', context)).toEqual({
      reason: 'out-of-context-variable',
      variable: 'householdId',
    });
  });

  it('reports a non-leaf, which would render as [object Object]', () => {
    expect(findTemplateProblem('{"a":"{{ user }}"}', context)).toEqual({
      reason: 'out-of-context-variable',
      variable: 'user',
    });
  });

  it('reports a prototype-chain name, which is not an own property', () => {
    expect(findTemplateProblem('{"a":"{{ user.constructor }}"}', context)).toEqual({
      reason: 'out-of-context-variable',
      variable: 'user.constructor',
    });
  });

  it('reports an empty-string leaf, which would render a clause that matches nothing', () => {
    expect(findTemplateProblem('{"a":"{{ user.id }}"}', { user: { id: '' } })).toEqual({
      reason: 'out-of-context-variable',
      variable: 'user.id',
    });
  });

  it('reports a non-string leaf', () => {
    expect(findTemplateProblem('{"a":"{{ user.id }}"}', { user: { id: 5 } })).toEqual({
      reason: 'out-of-context-variable',
      variable: 'user.id',
    });
  });

  it('reports the implicit iterator, which never resolves', () => {
    expect(findTemplateProblem('{"a":"{{ . }}"}', context)).toEqual({
      reason: 'out-of-context-variable',
      variable: '.',
    });
  });

  it('reports a template that does not parse', () => {
    expect(findTemplateProblem('{"a":"{{ user.id "}', context)).toEqual({ reason: 'malformed-template' });
  });

  it.each([
    ['{"a":"{{> partial }}"}', '>'],
    ['{"a":"{{! comment }}"}', '!'],
    ['{{=<% %>=}}{"a":"<% user.id %>"}', '='],
  ])('rejects the token type of %s', (template, tokenType) => {
    expect(findTemplateProblem(template, context)).toEqual({ reason: 'unsupported-token-type', tokenType });
  });

  it('walks section bodies, so a variable nested in a section is reported', () => {
    expect(findTemplateProblem('{"a":"{{#user.id}}{{ eventId }}{{/user.id}}"}', context)).toEqual({
      reason: 'out-of-context-variable',
      variable: 'eventId',
    });
  });

  it('reports the opener of an inverted section that does not resolve', () => {
    expect(findTemplateProblem('{"a":"{{^role}}x{{/role}}"}', context)).toEqual({
      reason: 'out-of-context-variable',
      variable: 'role',
    });
  });

  it('accepts a section whose opener and body both resolve', () => {
    expect(findTemplateProblem('{"a":"{{#user.id}}{{ user.id }}{{/user.id}}"}', context)).toBeNull();
  });
});

describe('renderPermissionConditions (#266, #1417)', () => {
  const context = { user: { id: 'u1' } };

  it('renders the conditions against the context', () => {
    expect(renderPermissionConditions({ createdById: '{{ user.id }}' }, context)).toEqual({ createdById: 'u1' });
  });

  it.each([
    ['an empty object', {}],
    ['null', null],
    ['an array', []],
    ['a string', 'x'],
  ])('returns undefined for %s', (_label, conditions) => {
    expect(renderPermissionConditions(conditions, context)).toBeUndefined();
  });
});
