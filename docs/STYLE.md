# Code style

Each rule here is enforced by a tool, which the rule's section names, and a
project's lint fails on a break. Prose in this guide covers only what no tool
can check. Line width and layout belong to Prettier.

The root files outside every Nx project (`eslint.config.mjs`, `scripts/`,
`utils/` and the root Jest and Prisma configs) have no lint target. Lint them
by hand with `npx eslint <file>` when you change them.

## Braces on every body

Every `if`, `else`, `for`, `while` and `do` body takes braces, including
one-statement bodies. A second statement added under a brace-less `if` runs
unconditionally, and braces leave one way of writing the body.

```ts
// no
if (seen.has(id)) continue;

// yes
if (seen.has(id)) {
  continue;
}
```

Prettier always prints a block on separate lines, so with the blank line that
follows a block (below), a guard clause takes four lines.

**Enforced by:** ESLint core `curly: ['error', 'all']`, with autofix, in the
root `eslint.config.mjs` (#1320). The Nx flat configs bring in
`eslint-config-prettier`, which turns `curly` off; the root block that sets it
comes after them, so it wins.

## A blank line after a block

A statement that ends in a closing brace (`if`, `else`, `for`, `while`,
`switch`, `try`, a bare block, a function declaration) is followed by a blank
line before the next statement. A closing brace, `else`, `catch` or `finally`
that follows directly is not a statement, so it stays where it is.

```ts
// no
if (!row) {
  continue;
}
const view = toView(row);

// yes
if (!row) {
  continue;
}

const view = toView(row);
```

**Enforced by:** `@stylistic/padding-line-between-statements` with
`{ blankLine: 'always', prev: 'block-like', next: '*' }`, with autofix (#1319).
`block-like` also matches an immediately invoked function statement. Prettier
keeps blank lines, so the two don't conflict.
