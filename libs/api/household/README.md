# household

Households: trust groups of any size whose members share their games and plan play together. This library serves the household, roster, invite and quota routes under `/api/households`.

## What each household role can do

The server decides what each request may do, and this table is what it grants. A client can read it, by the viewer's household role and the household's member invite policy, to hide what the viewer can't do. The server still refuses anything the table says No to.

<!-- household-role-table:start -->

| Action                                                                               | Household owner | Household admin | Member       | Household guest | Granted by     |
| ------------------------------------------------------------------------------------ | --------------- | --------------- | ------------ | --------------- | -------------- |
| See the household                                                                    | Yes             | Yes             | Yes          | Yes             | Household role |
| Edit the household and its settings                                                  | Yes             | Yes             | No           | No              | Household role |
| Delete the household                                                                 | Yes             | No              | No           | No              | Household role |
| See the roster                                                                       | Yes             | Yes             | Yes          | Yes             | Household role |
| Change the household role of someone with the member or guest role                   | Yes             | Yes             | No           | No              | Household role |
| Make someone a household admin, or change a household admin's role                   | Yes             | No              | No           | No              | Household role |
| Remove someone with the member or guest role                                         | Yes             | Yes             | No           | No              | Household role |
| Remove a household admin                                                             | Yes             | No              | No           | No              | Household role |
| Remove another household owner, unless they are the last                             | Yes             | No              | No           | No              | Household role |
| Transfer ownership                                                                   | Yes             | No              | No           | No              | Household role |
| Leave the household                                                                  | Yes             | Yes             | Yes          | Yes             | Household role |
| See the household's invites                                                          | Yes             | Yes             | No           | No              | Household role |
| Invite with the member or guest role, when the member invite policy is Direct        | Yes             | Yes             | Yes          | No              | Household role |
| Invite with the member or guest role, when the member invite policy is NeedsApproval | Yes             | Yes             | For approval | No              | Household role |
| Invite with the member or guest role, when the member invite policy is Off           | Yes             | Yes             | No           | No              | Household role |
| Invite with the household admin role                                                 | Yes             | No              | No           | No              | Household role |
| Approve an invite sent for approval                                                  | Yes             | Yes             | No           | No              | Household role |
| Revoke an invite offering the member or guest role                                   | Yes             | Yes             | No           | No              | Household role |
| Revoke an invite offering the household admin role                                   | Yes             | No              | No           | No              | Household role |
| Create a household event                                                             | Yes             | Yes             | Yes          | No              | Household role |
| See household events, their occurrences and their event policies                     | Yes             | Yes             | Yes          | Yes             | Household role |
| See the attendees of household events                                                | Yes             | Yes             | Yes          | No              | Household role |
| Edit any household event                                                             | Yes             | Yes             | No           | No              | Household role |
| Cancel an occurrence of any household event                                          | Yes             | Yes             | No           | No              | Household role |
| Delete an occurrence of a household event they don't host                            | No              | No              | No           | No              | Household role |
| Delete a household event they don't host                                             | No              | No              | No           | No              | Household role |
| Record a household play                                                              | Yes             | Yes             | Yes          | No              | Household role |
| Edit or delete a household play                                                      | Yes             | Yes             | No           | No              | Household role |
| Record results for a household play                                                  | Yes             | Yes             | Yes          | No              | Household role |
| Manage the household's plugins                                                       | Yes             | Yes             | No           | No              | Household role |
| See the household's quotas                                                           | Yes             | Yes             | No           | No              | Household role |
| Set quotas for each membership                                                       | Yes             | Yes             | No           | No              | Household role |
| See the household's game pool                                                        | Yes             | Yes             | Yes          | Yes             | User           |
| Join a play as a player                                                              | Yes             | Yes             | Yes          | Yes             | User           |
| Create and edit house rules                                                          | Yes             | Yes             | Yes          | Yes             | User           |

<!-- household-role-table:end -->

`src/lib/household-role-table.spec.ts` asks each role's real permissions every question in this table, and compares the table here with its own. A change to either fails until both agree.

- **Granted by User:** these rows come from User, the base role every registered user holds, not from the household role. No household role can take them away. Narrowing one for guests would mean changing the User role's own permission.
- **Only a household owner acts on the household admin role (#168).** A household admin changes the household role of, removes, invites and revokes the invites of people with the member or guest role. Nobody changes their own household role. A household admin who wants to step down asks an owner, or leaves.
- **The member invite policy (#166)** decides how people with the member role invite: directly, for a household owner's or admin's approval, or not at all. Household owners and admins always invite directly, and household guests never invite.
- **Withdrawing an invite you sent** needs no permission (#164). Revoking is cancelling an invite someone else sent.
- **The last owner** can't leave or be removed until they transfer ownership.
- **Event roles** (host, co-host and the rest) are separate from household roles, and someone who creates a household event hosts it. Household owners and admins edit and cancel the household's events and their occurrences, but deleting an event is its host's (#567), and deleting an occurrence belongs to the event's own roles.
- **Restoring a deleted household** is open to any of its owners during the restore window. The deletion grants it, one household at a time, rather than a household role (#175).
- **Plays** have no routes yet (#478), so their rows say what the household roles will hold once they do.
- **Custom household roles** are undecided (#169). Until they exist, a client may read this table by role name.

## Running unit tests

Run `npm run nx -- test @board-games-empire/household` to execute the unit tests via [Jest](https://jestjs.io).
