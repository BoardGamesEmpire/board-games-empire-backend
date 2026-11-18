# Code style

Each rule's section names what enforces it. Nearly every rule is enforced by
a tool, and a project's lint fails on a break; prose in this guide covers only
what no tool can check. Line width and layout belong to Prettier.

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

## Members in alphabetical order

The members of an interface or an object type literal are in alphabetical
order by name: natural order and case-insensitive, so `field2` comes before
`field10`. There are no exceptions such as `id` first. A member's doc comment
moves with it.

```ts
// no
interface DataGatewaySectionView {
  lastLoadedAt: Date | null;
  capability: DataGatewayCapability;
  failure: SectionFailure | null;
}

// yes
interface DataGatewaySectionView {
  capability: DataGatewayCapability;
  failure: SectionFailure | null;
  lastLoadedAt: Date | null;
}
```

Overloads of one name keep their order, and call and construct signatures stay
where they are, because overload order decides which signature TypeScript
picks.

Not in scope:

- **Class properties, DTOs included.** Their order reaches runtime: some
  initializers read `this.x`, and a DTO's property order sets the OpenAPI
  property order and the order of its validation messages.
- **Enums.** A numeric enum's values follow its member order.
- **Object literals.** These are values, not field declarations.

**Enforced by:** `perfectionist/sort-interfaces` and
`perfectionist/sort-object-types`, with autofix, using the root config's
`sortedMemberOptions` (#1374). Blank lines don't split the sort, and the sort
leaves them alone; the next section sets them.

## Blank lines between members

In an interface, an object type literal or a class's property list, a member is
_special_ when it carries a comment above it (a doc comment, a block comment or
a line comment) or spans more than one line, its decorators included. A blank
line goes before a special member and before the member after one. Between two
plain one-line members there is no blank line. The first member is never
checked. With the members sorted, their order alone decides every blank line.

```ts
interface DataGatewaySectionView {
  capability: DataGatewayCapability;

  /** The last failure, only while it's current. */
  failure: SectionFailure | null;

  lastLoadedAt: Date | null;
}
```

A comment on the same line as a member trails that member; it doesn't make the
member below special. A decorated class property with its decorator on its own
line is multi-line, so DTO fields get the same separation.

Class methods are out of scope: in a class body, a pair with a method on either
side keeps whatever spacing it has. Members that share one line are left to
Prettier.

**Enforced by:** `bge/member-blank-lines`, with autofix, defined in the root
`eslint.config.mjs` (#1318).

## Type-only imports

A name imported only as a type goes in an `import type { … }` statement of its
own. No inline `type` specifiers inside a value import.

```ts
// no
import { DatabaseService, type EventOccurrence } from '@bge/database';

// yes
import type { EventOccurrence } from '@bge/database';
import { DatabaseService } from '@bge/database';
```

**The decorated-file limit.** In a file that contains a decorator, a class
named in a decorated signature, such as a constructor-injected service, has to
stay a value import: TypeScript emits it into the decorator metadata Nest reads
for dependency injection, and as a type import it would become `Object`. Only
type information can tell which imports that applies to, so the rule skips
files with a decorator entirely. There, a plain import used only as a type
stays as written. Inline `type` specifiers still move to their own statement in
those files, since they are erased either way.

**Why the parser flags are set.** The rule knows to skip decorated files only
when the parser is told that `emitDecoratorMetadata` and
`experimentalDecorators` are on. No ESLint config here uses type information
(`parserOptions.project`), so the root config passes both flags as
`decoratorParserOptions`. Without them, the autofix would break Nest DI.

`typeof import('x')` type annotations stay allowed, as in
`jest.requireActual<typeof import('x')>('x')`.

**Enforced by:** `@typescript-eslint/consistent-type-imports` with
`prefer: 'type-imports'` and `fixStyle: 'separate-type-imports'`, and
`bge/top-level-type-imports`, which moves inline `type` specifiers out; both
with autofix (#1317). `prettier-plugin-organize-imports` keeps an
`import type` statement and a value import of the same module apart.

## Data from outside the process

Data that comes from outside the process is parsed through a zod schema, and
its type comes from the schema (`z.infer<typeof schema>`), not from a cast.
Outside the process covers a Redis message, an HTTP response body, a file on
disk, a gRPC field carrying JSON, and anything a plugin returns.

```ts
// no
const event = JSON.parse(message) as PluginConfigReloadEvent;

// yes
export const pluginConfigReloadEventSchema = z.object({ slug: z.string().min(1) }).readonly();
export type PluginConfigReloadEvent = z.infer<typeof pluginConfigReloadEventSchema>;

const parsed = pluginConfigReloadEventSchema.safeParse(JSON.parse(message));
```

The schema replaces the interface, in the same file, and each field's doc
comment moves onto the schema property. Parse with `safeParse`.

A hand-written type guard (`x is T`, `asserts x is T`) is for small shapes only,
and it checks every field the type claims. TypeScript doesn't check a guard's
body against its type, so a guard that skips a field is a cast with extra
steps, and it drifts when the type changes. A schema can't drift from the type
it produces.

What a failed parse does:

- **A pub/sub message:** log one line naming the channel and the problem, and
  drop the message. It never throws into the subscriber, and the next message
  is still handled.
- **An HTTP body or a plugin result:** an error with a stable code, so callers
  and clients can tell malformed data from a failed request.
- **A file on disk:** an error naming the file.

**Enforced by:** review (#1322): no lint rule can tell a cast of outside data
from any other cast. The no-casts rule (#1321) catches the cast that a missing
schema usually leaves behind.

## No casts outside tests

Outside tests, code doesn't cast. Where a value has to match a type,
`satisfies`, a type annotation or a narrowing says so, and the compiler checks
it. `as const` is not a cast and stays allowed.

```ts
// no
const body = { code, message } as ErrorBody;

// yes
const body = { code, message } satisfies ErrorBody;
```

Tests may cast. The exemption covers spec files (`*.spec.ts`,
`*.e2e-spec.ts`), the e2e apps (`apps/*-e2e`), the image smoke test, the test
support libs (`@bge/testing`, `testing-e2e`, the DataGateway driver contract
tests) and `*.fixture.ts` files.

Every cast that remains is one of three kinds:

1. **The compiler can check it.** Rewrite it, with no disable comment:

   ```ts
   // libs/api/gateway-coordinator-client/src/lib/coordinator.module.ts
   channelOptions: {
     interceptors: [createOutboundActorMetadataInterceptor()],
   } satisfies ChannelOptions,
   ```

2. **Data from outside the process.** It belongs in a schema (see above). Until
   it has one, the cast stays with a comment that cites #1322:

   ```ts
   // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- data from outside the process; parse it through a schema (#1322)
   return (await response.json()) as TokenResponse;
   ```

3. **Truly necessary.** Narrowing TypeScript can't follow, Prisma's JSON
   types, a generic the compiler can't relate. The cast stays with a reason
   that names the actual gap. An `as unknown as` says why both steps are
   needed.

   ```ts
   // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- LocalSearchScope's brand is declared and never present at runtime; this is the one place that mints it (#472)
   return this.scopeComposer.compose(ResourceType.Game, Action.read, gameListScope(userId)) as LocalSearchScope;
   ```

Every `eslint-disable` comment, for any rule, gives its reason after `--`.

**Enforced by:** `@typescript-eslint/consistent-type-assertions` with
`assertionStyle: 'never'` outside the exempt files, and
`@eslint-community/eslint-comments/require-description` everywhere (#1321).
