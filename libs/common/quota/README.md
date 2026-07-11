# @bge/quota

Operational cap primitive for Board Games Empire — configurable limits an admin sets (or doesn't). **Not billing-aware**: it answers "is this write within the configured cap?", nothing about money or tiers. The hosted service drives caps per subscription tier through the admin API; self-hosters set them once or leave everything unlimited.

The lib ships two things:

- `QuotaService.check(...)` — call it on a write path to enforce a cap.
- `QuotaService.getQuotas(...)` / `setQuota(...)` — read/write the cap rows (the HTTP admin surface that wraps these lives in `@bge/quotas`).

> Absence of a quota row means **unlimited**. A fresh install enforces nothing until someone sets a row.

---

## Concepts

### Scopes

A cap is attached to one `QuotaScope` target:

| Scope             | Target             | Example                                |
| ----------------- | ------------------ | -------------------------------------- |
| `Server`          | the whole instance | total storage across everyone          |
| `Household`       | one household      | members per household                  |
| `HouseholdMember` | one membership     | a member's slice of the household pool |
| `User`            | one user           | webhook subscriptions per user         |

### Resolution

Two independent operations, often conflated as "strictest wins":

1. **Within a scope, most-specific wins.** An _instance_ row (e.g. `Household` `hh_42`) overrides the _type-level default_ for that scope — including a disabling override (`enforced: false` → unlimited for that scope). The default is a row whose target is the whole scope class, stored under the sentinel `scopeId` `'*'` and surfaced as `scopeId: null`.
2. **Across scopes, every applicable scope is an independent ceiling.** A write is checked against each scope the resource is _measured_ in; usage is computed **per scope** and the write must satisfy every _hard_ constraint. This is stronger than `min(limit)` because usage differs per scope. The reported binding constraint is the one with least headroom (hard violations first).

Net effect — the "painless" path: set **one** `Server` (or per-scope) default row and every instance is capped; set an instance row to override; a household admin can only ever _tighten_ via a `HouseholdMember` sub-limit, never raise a server- or tier-set ceiling, because each scope is its own ceiling.

### Soft / hard / enforced

- `enforced: false` — master off switch; the row is ignored (unlimited) without deleting it.
- `softOverage: true` — warn-but-allow: the write proceeds and a `quota.soft_overage.v1` event fires on **every** over-limit call. `check()` emits it eagerly (read path); the transactional `consume()` gate does **not** emit — it returns the warning on `result.softOverages` so the caller emits it via `quota.emitSoftOverages(...)` after commit, and it never fires for a rolled-back write.
- `softOverage: false` (default) — hard block: `check()` returns `allowed: false`.

---

## Setup

`QuotaModule` provides and exports `QuotaService` + `QuotaResourceRegistry`. Import it wherever you enforce a cap:

```ts
import { QuotaModule } from '@bge/quota';

@Module({
  imports: [QuotaModule],
  // ...
})
export class HouseholdModule {}
```

`EventEmitter2` is expected from the app's global `EventEmitterModule` (used to emit `quota.updated.v1` / `quota.soft_overage.v1`).

---

## Enforcing a quota (`check`)

The canonical pattern: on the write path, ask `check(resource, amount, ctx)` whether `amount` more is allowed, and throw `QuotaExceededException` if not.

```ts
import { QuotaExceededException, QuotaService } from '@bge/quota';
import { Injectable } from '@nestjs/common';

@Injectable()
export class HouseholdMemberService {
  constructor(private readonly quotas: QuotaService) {}

  async addMember(householdId: string, actorId: string, newUserId: string) {
    const result = await this.quotas.check('household_member_count', 1n, {
      userId: actorId,
      householdId,
    });

    if (!result.allowed) {
      // On a hard block the binding scope/limit/usage are always populated.
      throw new QuotaExceededException(
        'household_member_count',
        result.scope!,
        result.limit!,
        result.currentUsage!,
        1n,
      );
    }

    // ...proceed with the insert
  }
}
```

`amount` is a `bigint` (e.g. `1n` for a count, byte deltas for storage) and must be non-negative — a negative amount throws `BadRequestException` rather than silently buying headroom. `ctx.userId` is required; supply `householdId` / `householdMemberId` only when the write is attributed to them. A scope the resource is measured in but whose id is absent from `ctx` is simply skipped.

### The result

```ts
interface QuotaCheckResult {
  allowed: boolean; // false only when a HARD constraint is exceeded
  scope: QuotaScope | null; // the binding scope (null when no cap applied)
  currentUsage: bigint | null; // usage at the binding scope
  limit: bigint | null; // limit at the binding scope
  softOverage: boolean;
  constraints: readonly QuotaConstraint[]; // per-scope breakdown
  softOverages: readonly QuotaSoftOverageEvent[]; // soft caps crossed, ready to emit
}
```

- No row anywhere → `{ allowed: true, scope: null, limit: null, constraints: [], softOverages: [] }`.
- Soft overage → `allowed: true`; the warning(s) ride on `result.softOverages`. `check()` has already emitted them; a `consume()` caller emits them with `quota.emitSoftOverages(result.softOverages)` after its transaction commits.
- A `check()` for a **pending** resource (registered but not yet measurable — see below) **throws**. This is deliberate: no write path should be enforcing a resource that has no usage provider yet.

---

## Managing quotas (`setQuota` / `getQuotas`)

These are normally reached through the `@bge/quotas` HTTP controller (`PATCH /api/quotas/:scope/:scopeId/:resource`), but the service methods are the programmatic entry points.

```ts
// Set a Server-wide default of 5 GiB of storage for every user.
// publicScopeId = null addresses the type-level default (stored as '*').
await quotas.setQuota(QuotaScope.User, null, 'storage_bytes', { limit: '5368709120' }, actorId, abilities);

// Override one household to 25 members, with a note.
await quotas.setQuota(
  QuotaScope.Household,
  'hh_42',
  'household_member_count',
  { limit: '25', description: 'Board game café — larger group' },
  actorId,
  abilities,
);

// Partial update: change only enforcement, leave the limit untouched.
await quotas.setQuota(QuotaScope.Household, 'hh_42', 'household_member_count', { enforced: false }, actorId, abilities);
```

Notes:

- **`limit` is required to create**, optional to update. A limit-less call on a non-existent row is rejected; on an existing row it patches only the fields you pass.
- **`bigint` crosses every boundary as a decimal string** (`limit: '5368709120'`) — JSON can't carry `bigint` losslessly. `QuotaView.limit` comes back as a string too.
- The `scope` must be one the resource declares in `applicableScopes`, otherwise the write is rejected (a row at an unmeasured scope would be dead config).
- `abilities` is the caller's CASL ability set; `setQuota` re-authorizes the **concrete row** inside its transaction (the controller's type-level `PoliciesGuard` can't see conditions), so a household admin can't write a `Server` or other-household row even though they pass the guard.

`getQuotas(abilities)` returns the rows the caller may read, narrowed by the two-ability intersection (server admin sees all; household admin sees their own household via the denormalized `householdId`).

---

## The resource registry

`QuotaResourceRegistry` is a stateless catalogue (mirrors `WebhookEventRegistry`). Each entry declares which scopes the resource is measured in and how to count current usage.

Shipped resources:

| Resource                     | Scopes                | Status                              |
| ---------------------------- | --------------------- | ----------------------------------- |
| `household_member_count`     | `Household`           | enforceable                         |
| `webhook_subscription_count` | `User`                | enforceable                         |
| `storage_bytes`              | `Server`, `User`      | **pending #58** (no usage provider) |
| `plugin_install_count`       | `Server`, `Household` | **pending #59**                     |

A **pending** resource has no `usage` provider: caps can be pre-provisioned through `setQuota`, but `check()` against it throws until the underlying model exists. `requireUsage(resource)` is what enforces this.

### Adding a resource

Two coordinated edits:

1. Add the key to the `QUOTA_RESOURCES` tuple in `constants/quota-resource.ts` (this is what the `QuotaResource` union derives from).
2. Add a definition to the registry map. Provide a `usage` provider to make it enforceable.

```ts
// usage providers receive the RESOLVED target. For Server the scopeId is the
// sentinel '*' — treat Server as the global aggregate and ignore scopeId.
[
  'game_collection_size',
  {
    key: 'game_collection_size',
    applicableScopes: [QuotaScope.User],
    usage: this.countOwnedGames.bind(this),
  },
],

// ...
private async countOwnedGames(_scope: QuotaScope, scopeId: string): Promise<bigint> {
  const count = await this.databaseService.gameCollectionItem.count({ where: { ownerId: scopeId } });
  return BigInt(count);
}
```

---

## Events

Emitted on `EventEmitter2`:

| Event                   | Constant                  | When                                                                                  |
| ----------------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| `quota.updated.v1`      | `QuotaEvents.Updated`     | a cap is created/changed (auditable)                                                  |
| `quota.soft_overage.v1` | `QuotaEvents.SoftOverage` | over-limit soft call — `check()` emits eagerly; `consume()` caller emits after commit |

Payloads carry `bigint` fields as strings and surface `scopeId` as `null` for defaults. The full change history with actor lives in the audit log (#57) via the auditable `quota.updated.v1` event — the `createdById` / `updatedById` row columns are current-state attribution, not a history substitute.

---

## Authorization

CASL is DB-driven (`Permission` rows, Mustache-templated conditions). Server admins get unconditional `manage`/`read` on `Quota`; household admins (and owners) get `manage` on `{ scope: 'HouseholdMember', householdId: '{{ householdId }}' }` plus `read` on their household's rows. Because the controller guard is type-level, instance authorization is enforced in `setQuota` via `accessibleBy(ability, manage)` against the upserted row inside the transaction — an unauthorized target rolls the write back with `ForbiddenException`.

---

## Testing

The service resolver is tested against a controllable registry stub so resolution logic stays isolated from the concrete usage SQL (which the registry's own spec covers against `MockDatabaseService`):

```ts
const registry = { has: jest.fn(), require: jest.fn(), requireUsage: jest.fn() };

const moduleRef = await createTestingModuleWithDb({
  providers: [
    QuotaService,
    { provide: QuotaResourceRegistry, useValue: registry },
    { provide: EventEmitter2, useValue: { emit: jest.fn() } },
  ],
});

// drive a single-scope resource with a fixed usage, then assert on check()
registry.requireUsage.mockReturnValue(async () => 5n);
db.quota.findMany.mockResolvedValue([
  { scope: QuotaScope.User, scopeId: 'user_1', limit: 5n, softOverage: false, enforced: true },
]);

await expect(service.check('storage_bytes', 1n, { userId: 'user_1' })).resolves.toMatchObject({ allowed: false });
```

---

## API surface

- `QuotaService` — `check`, `consume`, `emitSoftOverages`, `getQuotas`, `setQuota`
- `QuotaResourceRegistry` — `has`, `require`, `requireUsage`, `keys`
- `QuotaExceededException` — `402`, carries the binding constraint (bigints as strings)
- Constants — `QUOTA_RESOURCES`, `QuotaResource`, `isQuotaResource`, `DEFAULT_SCOPE_ID`, `QuotaEvents`
- DTOs / views — `SetQuotaDto`, `QuotaView`
- Serialization — `toPublicScopeId`, `toStorageScopeId`, `toQuotaView`
- Interfaces — `QuotaCheckContext`, `QuotaCheckResult`, `QuotaConstraint`, `QuotaResourceDefinition`, `QuotaUsageProvider`, `QuotaUpdatedEvent`, `QuotaSoftOverageEvent`
