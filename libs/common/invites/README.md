# @bge/invites

The invite lifecycle for Board Games Empire, as primitives a context owner drives inside its own transaction. One service covers every kind of invite the `Invite` model knows (household, event, system, campaign); the module that owns the context (households today, events and campaigns later) injects it and decides who may call what.

The lib ships:

- `InviteService` — `findForParty`, `createWithin`, `acceptWithin`, `declineWithin`, `withdrawWithin`, `revokeWithin`, `approveWithin`, `revokeOutstandingWithin`, and `emit`.
- The read shapes every invite render goes through: `CONTEXT_INVITE_SELECT` (a context reader's view) and `PARTY_INVITE_SELECT` (a party's view).
- The domain events a consumer announces after commit, and `effectiveInviteStatus` for lazy expiry on reads.

> The lib is the only writer of `Invite.status`. A consumer that writes the column directly is a bug.

---

## The seam

Every write is a `*Within(tx, …)` taking the caller's `Prisma.TransactionClient`, the shape of `HouseholdMemberService.addMemberWithin`. The consumer owns the transaction because it owns the duties that go with it: admitting the member an accept implies, invalidating ability caches, emitting its own domain events.

Each primitive hands back two things: the row as the caller may show it, and the domain event to announce. The caller emits that domain event **after** its transaction commits, through `InviteService.emit(...)`. Emitting inside the transaction would announce a transition a rollback then undoes. This is the ride-back `QuotaService.consume` uses for its soft overages. (`createWithin` hands back a third thing, `expired`: see Expiry below. Emit those with the created event.)

```ts
import { InviteService } from '@bge/invites';

@Injectable()
export class HouseholdService {
  constructor(
    private readonly db: DatabaseService,
    private readonly invites: InviteService,
  ) {}

  async deleteHousehold(id: string) {
    const { household, revocation } = await this.db.$transaction(async (tx) => {
      const household = await tx.household.update({ where: { id }, data: { deletedAt: new Date() } });
      const revocation = await this.invites.revokeOutstandingWithin(tx, { householdId: id });
      return { household, revocation };
    });

    // Committed. Now, and only now, announce it.
    this.invites.emit(revocation.events);

    return household;
  }
}
```

`emit` never throws into the caller: the app's `EventEmitterModule` runs without `ignoreErrors`, so a synchronous listener that throws would otherwise turn a committed transition into a failed request. A failing listener is logged and the remaining domain events still go out.

---

## Who may do what

A **party** read or transition binds its `where` to the acting user, as inviter or invitee:

| Primitive        | Who          | Bound by                                                | Returns      |
| ---------------- | ------------ | ------------------------------------------------------- | ------------ |
| `findForParty`   | either party | `inviterId` or `inviteeId`, or the token for email-only | party view   |
| `createWithin`   | the inviter  | `inviterId` is the caller's acting user                 | party view   |
| `acceptWithin`   | the invitee  | `inviteeId`, or the token for email-only                | party view   |
| `declineWithin`  | the invitee  | `inviteeId`, or the token for email-only                | party view   |
| `withdrawWithin` | the inviter  | `inviterId`                                             | party view   |
| `revokeWithin`   | context      | nothing: the caller asserted the authority              | context view |
| `approveWithin`  | an approver  | nothing: the caller asserted the authority              | context view |

A stranger addressing an invite that is not theirs, by id or by a link that is not theirs, meets a **404**: the binding is in the query, so the row is never found, and nothing confirms the invite exists. A party in the wrong role, the inviter trying to accept, meets a **403**.

**Context authority is the consumer's to assert before calling.** An owner or admin revoking, an approver approving: the lib never checks a household or event role, and needs no `read` grant on `Invite` to do its work. That is also why an email-only invite, whose invitee is not a registered user and so can hold no grant, is reachable at all.

An email-only invite (no `inviteeId`) answers only to the token its link carries. Addressed by id it answers to nobody, not even its inviter: the id is public to every context reader through the household detail, the token is not. Accepting or declining by token binds the invite to the user who responded. The inviter never answers by either route: `createWithin` refuses a self-invite by id, but cannot tell that an address is the inviter's own, so the link such an invite mails them is refused at accept and decline instead.

An invite names exactly the context its type allows: a household invite a `householdId` and no `eventId`, an event invite the reverse, a system or campaign invite neither. A row carrying both would sit inside both context indexes and be revoked when either context closed.

`roleId` is opaque to the lib. Which roles are assignable in which context is the consumer's rule.

---

## The matrix

```
Pending          → Accepted  (invitee)
                 → Declined  (invitee)
                 → Withdrawn (inviter)
                 → Revoked   (context authority)
                 → Expired   (clock)

AwaitingApproval → Pending   (approver; stamps approvedBy / approvedAt)
                 → Declined  (invitee — a refusal never waits on someone else's approval)
                 → Withdrawn (inviter)
                 → Revoked   (context authority)
                 → Expired   (clock)

Accepted, Declined, Withdrawn, Revoked, Expired are terminal.
```

An accept from `AwaitingApproval` is refused as "awaiting approval", not as "settled": the invite is not yet the invitee's to accept.

### How a transition is made safe

The row is read, refused for the right reason if it cannot move, and then updated with its **current status in the `where`**. A concurrent transition between the read and the update leaves that guard unmatched. The row is then re-read and the miss is reported as the transition it now refuses: a rival accept makes this one "already accepted", a rival sweep makes it "expired". Only when the re-read row would still allow the transition is the answer a bare "try again". Nothing ever overwrites the rival's result.

Reading first is also what lets every domain event carry the status the row actually left, which a decline from either outstanding status could not otherwise know.

Refusals, in the order they are checked:

| Situation                                            | Status | Key                                                             |
| ---------------------------------------------------- | ------ | --------------------------------------------------------------- |
| no such id, no such token, or not this user's invite | 404    | `not_found` / `link_not_found`                                  |
| a party, but not the one this transition needs       | 403    | `only_invitee_responds` / `only_inviter_withdraws`              |
| outstanding but past `expiresAt`                     | 410    | `expired`                                                       |
| accept on `AwaitingApproval`                         | 409    | `awaiting_approval`                                             |
| approve on anything but `AwaitingApproval`           | 409    | `not_awaiting_approval`                                         |
| settled                                              | 409    | `not_outstanding`                                               |
| moved between the read and the guarded update        | 409    | the transition the row now refuses, else `changed_concurrently` |

All keys live under `errors.invite.*`.

---

## Expiry

Expiry is lazy. Nothing stamps `Expired` the moment `expiresAt` passes:

- **Reads compute it.** `findForParty` and `effectiveInviteStatus(row, now)` report an outstanding row past its date as `Expired` without touching it. Reads never write through. A listing filters the same way with `unexpiredInviteWhere(now)` beside its status filter, as the household detail embed does, so a list and a read never disagree about the same row.
- **Transitions persist it as their failure path.** A transition that meets an expired outstanding row stamps `Expired`, announces `invite.expired`, and refuses with 410.
- **A create persists it for the rows in its way.** An expired-but-unstamped invite is still inside the partial unique index, so `createWithin` first stamps `Expired` any outstanding invite to the same invitee (by id or address) under the same context whose window has closed, on the caller's transaction, and hands their `invite.expired` events back as `expired` beside the created event. A re-invite after expiry therefore never waits on the sweep.
- **The sweep persists the rest** (#165).

The transition's stamp is written on the lib's own connection, **not** the caller's transaction, on purpose: the refusal that follows is thrown, which rolls the caller's transaction back, and the stamp has to outlive it. It is started and not awaited: the caller's transaction holds one pool connection and the stamp needs another, and a refusal that waited for the second while holding the first would, under a pool full of such requests, wait on itself until the pool timeout. The statement is guarded on the status and date the row was read in, so a rival landing first leaves nothing for it to do, and the domain event goes out only when this statement moved the row. A failure in the stamp is logged and changes nothing about the 410 already given.

`revokeOutstandingWithin` is the one exception: a context being closed revokes its expired-but-unstamped rows with the rest. The context is gone, and there is nobody left to tell "expired" instead.

Both bulk statements (`revokeOutstandingWithin`, and the create's stamp above) visit one status at a time so each domain event carries the status its row left, and they visit `AwaitingApproval` **before** `Pending`. The only transition between the two is approve, and it only goes that way, so a row a rival approve moves in between is `Pending` by the second statement and still caught.

---

## Duplicates

A second outstanding invite to the same invitee for the same context is refused by the **database**, not by a lookup: four hand-written partial unique indexes in `20261012000000_invite_outstanding_unique`, on `(household_id, invitee_id)`, `(household_id, invitee_email)` and the same pair on `event_id`, each `WHERE status IN ('Pending', 'AwaitingApproval')`. The lib maps the resulting P2002 to 409 by the column pair the driver adapter names.

A settled invite sits outside those indexes, so a re-invite after a decline, a withdrawal or an expiry is a fresh row with a fresh token, never a repurposed one. An invite that expired but was never stamped is still inside them; `createWithin` stamps such rivals first (see Expiry). `apps/api-e2e/src/invite` pins the index set and the P2002 identity against a real database, since Prisma cannot model a partial index and the schema does not mention them.

The email column is compared as stored; the lib trims and lower-cases it before every insert.

The id pair and the email pair are separate indexes, so the same person can hold an email-only invite and a user-bound invite to one context at once. The lib binds parties by id and does not resolve an address to a user; a route that accepts an address should resolve a registered one to its user first and open a user-bound invite (#162).

---

## The token

`Invite.token` is 32 random bytes as base64url, minted on create and stored as minted. It is the accept credential for an email-only invite, and it is **never** selected into a response shape, never logged, and never on a domain event payload. `read-shapes.spec.ts` and the domain event specs pin each of those.

The token is probed free before the insert rather than retried after a collision, because a P2002 aborts the caller's transaction and Prisma opens no savepoint: the next statement on that transaction fails whatever it is. On 256 random bits the probe is a formality, bounded so a broken random source surfaces as an error rather than a spin.

Hashing the token at rest, and resend semantics, are #173's questions.

---

## Domain events

Every primitive hands back a `MutationEvent` subclass, audited by default:

| Domain event           | Name               | `action` |
| ---------------------- | ------------------ | -------- |
| `InviteCreatedEvent`   | `invite.created`   | create   |
| `InviteAcceptedEvent`  | `invite.accepted`  | update   |
| `InviteDeclinedEvent`  | `invite.declined`  | update   |
| `InviteWithdrawnEvent` | `invite.withdrawn` | update   |
| `InviteRevokedEvent`   | `invite.revoked`   | update   |
| `InviteApprovedEvent`  | `invite.approved`  | update   |
| `InviteExpiredEvent`   | `invite.expired`   | update   |

The snapshot carries the party and context ids (`inviterId`, `inviteeId`, `inviteeEmail`, `inviteeName`, `householdId`, `eventId`, `roleId`), the status, `expiresAt` and `respondedAt`, so a listener can resolve its recipients without re-reading the invite. `inviteeEmail` reaches in-process listeners and is stripped from persisted audit rows (`@AuditExclude`). The token is never on a snapshot.

No invite webhook exists. Whether one should is a per-event decision on #245, and `Invite` has no `WebhookVisibilityService` entry today.

---

## Read shapes

Two shapes, both `select`-based so a new column is invisible until someone names it (#297):

- `CONTEXT_INVITE_SELECT` — what a context reader sees: `id`, `status`, `type`, `inviteeName`, `expiresAt`, `createdAt`, `role { id, name }`, `inviter { id, username, profile }`. The household detail embed uses it.
- `PARTY_INVITE_SELECT` — that plus `inviteeEmail` and `message`, for the inviter and the invitee on their own rows only.

`read-shapes.spec.ts` reads the model's scalars out of the generated client and fails until every one is classified as published, party-only, or withheld with a reason. A consumer listing invites for a context must not widen to the party shape: that re-opens the address to every co-member, which is the leak #297 closed.

---

## Setup

```ts
import { InvitesModule } from '@bge/invites';

@Module({
  imports: [InvitesModule],
})
export class HouseholdModule {}
```

`InvitesModule` provides and exports `InviteService`. It imports `DatabaseModule` for the party read and for the one write that must not share the caller's transaction (the refused transition's expiry stamp above). `EventEmitter2` is expected from the app's global `EventEmitterModule`.
