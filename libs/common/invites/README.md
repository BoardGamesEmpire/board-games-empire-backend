# @bge/invites

The invite lifecycle for Board Games Empire, as primitives a context owner drives inside its own transaction. One service covers every kind of invite the `Invite` model knows (household, event, system, campaign); the module that owns the context (households today, events and campaigns later) injects it and decides who may call what.

The lib ships:

- `InviteService` — `findForParty`, `findPartyScopeWithin`, `createWithin`, `acceptWithin`, `declineWithin`, `withdrawWithin`, `revokeWithin`, `approveWithin`, `revokeOutstandingWithin`, `expireOutstandingWithin`, and `emit`.
- `receivedInviteWhere`, the filter a listing of the invites a user has received is built on.
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

`emit` never throws into the caller and never waits for a listener. A listener declared with `@OnEvent` is wrapped by Nest's loader, which awaits it and logs a throw or a rejection (`suppressErrors` defaults to true), so its failure never reaches `emit` at all. A listener registered on the emitter directly (`onAny`, as the audit persistence listener is) has no wrapper, and the app's `EventEmitterModule` runs without `ignoreErrors`, so its synchronous throw would otherwise turn a committed transition into a failed request: `emit` logs it and the remaining domain events still go out. Such a listener's rejected promise is its own to catch, as both in the app do.

**Lock order: the context row, then the invite.** A context's delete locks its own row and then, through `revokeOutstandingWithin`, the invites into it. A consumer that holds its context row and transitions an invite in the same transaction takes them in that order too: lock the context row (`lockExistingHousehold` for a household) before the `*Within` call. The accept that admits a member is the case to get right, because `HouseholdMemberService.addMemberWithin` takes the household row `FOR SHARE`: an accept that transitioned the invite first and admitted second would hold the invite while waiting for the row a concurrent delete holds while waiting for the invite, and Postgres would abort one of them. Lock the household, then accept, then admit (#163). `TransactionDeadlockInterceptor` turns a victim into a retryable 409 either way; that is the backstop, not the design.

The party view leaves the household's id out, so a consumer accepting by id or by token learns which row to lock from `findPartyScopeWithin(tx, lookup, InviteType.Household)` first. It binds the read as the transition does, so a stranger meets the same 404 before any household is named to them, and it takes no lock. A transition binds the type in its own read, so a decline or a withdraw, which locks nothing, needs no such read first (#164).

---

## Who may do what

A **party** read or transition binds its `where` to the acting user, as inviter or invitee:

| Primitive              | Who          | Bound by                                                                       | Returns      |
| ---------------------- | ------------ | ------------------------------------------------------------------------------ | ------------ |
| `findForParty`         | either party | `inviterId` or `inviteeId`, or for email-only the token or a vouched address   | party view   |
| `findPartyScopeWithin` | either party | as `findForParty`, and the invite's type                                       | its context  |
| `createWithin`         | the inviter  | `inviterId` is the caller's acting user                                        | party view   |
| `acceptWithin`         | the invitee  | `inviteeId`, or for email-only the token or a vouched address; and the type    | party view   |
| `declineWithin`        | the invitee  | `inviteeId`, or for email-only the token or a vouched address; and the type    | party view   |
| `withdrawWithin`       | the inviter  | `inviterId`, and the type                                                      | party view   |
| `revokeWithin`         | context      | `scope`: the household or event the caller's authority covers; not the inviter | context view |
| `approveWithin`        | an approver  | `scope`, as a revoke                                                           | context view |

A stranger addressing an invite that is not theirs, by id or by a link that is not theirs, meets a **404**, and so does a context authority addressing an invite outside the context it was authorized over: the binding is in the query, so the row is never found, and nothing confirms the invite exists. A party in the wrong role, the inviter trying to accept, meets a **403**, and so does an inviter revoking their own invite: they withdraw it instead (#164).

**Context authority is the consumer's to assert before calling.** An owner or admin revoking, an approver approving: the lib never checks a household or event role, and needs no `read` grant on `Invite` to do its work. That is also why an email-only invite, whose invitee is not a registered user and so can hold no grant, is reachable at all. What the lib does bind is the context that assertion was about: `revokeWithin` and `approveWithin` take the `scope` the caller's authority covers, a `householdId` or an `eventId`, and carry it into the read. A route that authorized an admin on one household and was handed an invite id from another transitions nothing, because the consumer's role check and the lib's query name the same context and neither is satisfied by the other's.

**Withdraw and revoke never stand in for each other.** `revokeWithin` takes the `revokerId` and refuses the invite's own inviter, whatever authority they hold, and `withdrawWithin` answers to the inviter alone, whatever their role in the context now. So `invite.withdrawn` always means the sender took the invite back and `invite.revoked` always means someone else cancelled it, or the context closed (#164).

An email-only invite (no `inviteeId`) answers to the token its link carries, and to the account holding its address when the consumer vouches for that address. Addressed by id it answers to nobody else, not even its inviter: the id is public to every context reader through the household detail, the token and the address are not.

The address is the consumer's to vouch for, as `vouchedEmail` on the party lookup: the lib matches it, trimmed and lower-cased as it stores addresses, and never decides whose an address is. The household routes vouch for the acting user's address only once it is verified (#162, #724). A withheld invite is never reached by an address, as it is never reached by a token. `receivedInviteWhere(userId, vouchedEmail)` is the same rule as a `where` fragment, for a listing of the invites a user has received (#163's inbox), so a listed invite is always one its reader can answer by id.

Accepting or declining by token or by address binds the invite to the user who responded. The inviter never answers by either route: `createWithin` refuses a self-invite by id, but cannot tell that an address is the inviter's own, so the link such an invite mails them is refused at accept and decline instead. A withheld invite (below) answers to nobody by its token either.

An invite names exactly the context its type allows: a household invite a `householdId` and no `eventId`, an event invite the reverse, a system or campaign invite neither. A row carrying both would sit inside both context indexes and be revoked when either context closed.

`roleId` is opaque to the lib. Which roles are assignable in which context is the consumer's rule.

---

## The matrix

```
Pending          → Accepted  (invitee)
                 → Declined  (invitee)
                 → Withdrawn (inviter)
                 → Revoked   (context authority, never the inviter)
                 → Expired   (clock)

AwaitingApproval → Pending   (approver; stamps approvedBy / approvedAt)
                 → Declined  (invitee — a refusal never waits on someone else's approval)
                 → Withdrawn (inviter)
                 → Revoked   (context authority, never the inviter)
                 → Expired   (clock)

Accepted, Declined, Withdrawn, Revoked, Expired are terminal.
```

An accept from `AwaitingApproval` is refused as "awaiting approval", not as "settled": the invite is not yet the invitee's to accept.

### How a transition is made safe

The row is read, refused for the right reason if it cannot move, and then updated with its **current status in the `where`**. A concurrent transition between the read and the update leaves that guard unmatched. The row is then re-read and the miss is reported as the transition it now refuses: a rival accept makes this one "already accepted", a rival sweep makes it "expired". Only when the re-read row would still allow the transition is the answer a bare "try again". Nothing ever overwrites the rival's result.

Reading first is also what lets every domain event carry the status the row actually left, which a decline from either outstanding status could not otherwise know.

Refusals, in the order they are checked:

| Situation                                                                             | Status | Key                                                                      |
| ------------------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| no such id or token, not this user's invite or type, or not in the authorized context | 404    | `not_found` / `link_not_found`                                           |
| a party, but not the one this transition needs, or a revoke by the inviter            | 403    | `only_invitee_responds` / `only_inviter_withdraws` / `revoke_own_invite` |
| outstanding but past `expiresAt`                                                      | 410    | `expired`                                                                |
| accept on `AwaitingApproval`                                                          | 409    | `awaiting_approval`                                                      |
| approve on anything but `AwaitingApproval`                                            | 409    | `not_awaiting_approval`                                                  |
| settled                                                                               | 409    | `not_outstanding`                                                        |
| moved between the read and the guarded update                                         | 409    | the transition the row now refuses, else `changed_concurrently`          |

All keys live under `errors.invite.*`.

---

## Expiry

Expiry is lazy. Nothing stamps `Expired` the moment `expiresAt` passes:

- **Reads compute it.** `findForParty` and `effectiveInviteStatus(row, now)` report an outstanding row past its date as `Expired` without touching it. Reads never write through. A listing filters the same way with `unexpiredInviteWhere(now)` beside its status filter, as the household detail embed does, so a list and a read never disagree about the same row.
- **Transitions persist it as their failure path.** A transition that meets an expired outstanding row stamps `Expired`, announces `invite.expired`, and refuses with 410.
- **A create persists it for the rows in its way.** An expired-but-unstamped invite is still inside the partial unique index, so `createWithin` first stamps `Expired` any outstanding invite to the same invitee (by id or address) under the same context whose window has closed, on the caller's transaction, and hands their `invite.expired` events back as `expired` beside the created event. A re-invite after expiry therefore never waits on the sweep.
- **The sweep persists the rest** (#165). `expireOutstandingWithin(tx, { limit })` stamps `Expired` on outstanding invites of every type whose window has closed, at most `limit` from each outstanding status, and hands back `{ count, events, drained }`. It writes the status only, as the other two stamps do: nobody responded. A caller drains a backlog in batches, one transaction each, emitting each batch's events after its commit and stopping at the first batch that comes back `drained`.

The transition's stamp is written on the lib's own connection, **not** the caller's transaction, on purpose: the refusal that follows is thrown, which rolls the caller's transaction back, and the stamp has to outlive it. It is started and not awaited: the caller's transaction holds one pool connection and the stamp needs another, and a refusal that waited for the second while holding the first would, under a pool full of such requests, wait on itself until the pool timeout. The statement is guarded on the status and date the row was read in, so a rival landing first leaves nothing for it to do, and the domain event goes out only when this statement moved the row. A failure in the stamp is logged and changes nothing about the 410 already given.

`revokeOutstandingWithin` is the one exception: a context being closed revokes its expired-but-unstamped rows with the rest. The context is gone, and there is nobody left to tell "expired" instead.

The bulk statements (`revokeOutstandingWithin`, `expireOutstandingWithin`, and the create's stamp above) visit one status at a time so each domain event carries the status its row left, and they visit `AwaitingApproval` **before** `Pending`. The only transition between the two is approve, and it only goes that way, so a row a rival approve moves in between is `Pending` by the second statement and still caught.

`expireOutstandingWithin`'s `limit` reads that many ids per status and then updates them with the guard restated beside the ids. It never uses `updateManyAndReturn`'s own `limit`, which leaves the guard out of the update's outer `where` and so can overwrite a rival's committed transition; `settleOutstandingWithin`'s doc comment gives the mechanism. `drained` comes from those reads, not from the count: it is true only when every status's read came back under the limit. A rival that settles part of a full read leaves the count short with more still overdue, so a caller that stopped on the count would leave the rest of a backlog for the next run.

---

## Duplicates

A second outstanding invite to the same invitee for the same context is refused by the **database**, not by a lookup: four hand-written partial unique indexes in `20261012000000_invite_outstanding_unique`, on `(household_id, invitee_id)`, `(household_id, invitee_email)` and the same pair on `event_id`, each `WHERE status IN ('Pending', 'AwaitingApproval')`. The lib maps the resulting P2002 to 409 by the column pair the driver adapter names.

A settled invite sits outside those indexes, so a re-invite after a decline, a withdrawal or an expiry is a fresh row with a fresh token, never a repurposed one. An invite that expired but was never stamped is still inside them; `createWithin` stamps such rivals first (see Expiry). `apps/api-e2e/src/invite` pins the index set and the P2002 identity against a real database, since Prisma cannot model a partial index and the schema does not mention them.

The email column is compared as stored; the lib trims and lower-cases it before every insert.

The id pair and the email pair are separate indexes, so the same person can hold an email-only invite and a user-bound invite to one context at once. The lib binds parties by id and does not resolve an address to a user at create, and the household route does not either (#162). Binding the account that holds an address would show in how the create answers: the id index would refuse an invite by address beside one by id, and the route would refuse a member's address. Either refusal tells the inviter whose address it is. So an invite by address stays email-only until someone answers it, by its token or by an address the consumer vouches for, and it can stand beside an invite by id to the same person. Answering one leaves the other outstanding (#163).

---

## The token

`Invite.token` is 32 random bytes as base64url, minted on create and stored as minted. It is the accept credential for an email-only invite, and it is **never** selected into a response shape, never on a log line of the lib's own, and never on a domain event payload. `read-shapes.spec.ts` and the domain event specs pin each of those. The development query log (`DATABASE_LOG_QUERIES`, off by default and only wired when the client logs queries at all, which is development) prints every statement's parameters, so it prints the token with every other column and credential the app stores; hashing at rest (#173) is what takes the plaintext off the wire.

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

`withheld` is on no shape and in no domain event (#278). The household route sets it through `createWithin` when a block or the invitee's preference refuses an invite by address: the invite is stored and answered like any other, so the inviter cannot tell. Anything that delivers invites reads the mark from the row and skips the invite: #173's mail, and #163's inbox, which matches invites to an account by address through `receivedInviteWhere` and so never lists one. The token, which the mail needs, is on no event either, so a mailer reads the row anyway. If a withheld invite's link is sent all the same, whoever follows it meets the miss a stranger meets in `findForParty`, `findPartyScopeWithin`, `acceptWithin` and `declineWithin`, so the invitee cannot answer it; the account holding its address meets the same miss by id. Its inviter still reaches it like any other invite of theirs, so no read tells them it was withheld. Only an invite by address can be withheld: `createWithin` refuses the mark beside an `inviteeId`, since that invitee would reach the invite by id.

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
