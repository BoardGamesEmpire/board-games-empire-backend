# household

Households: trust groups of any size whose members share their games and plan play together. This library serves the household, roster, invite and quota routes under `/api/households`.

## What each household role can do

The server decides what each request may do, and this table is what it grants. A client can read it, by the viewer's household role and the household's member invite policy, to hide what the viewer can't do. The server still refuses anything the table says No to.

<!-- household-role-table:start -->

| Action                                                                               | Household owner | Household admin | Member role  | Household guest | Granted by     |
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
| List the household's invites                                                         | Yes             | Yes             | No           | No              | Household role |
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
- **Pending invites come with the household.** Reading the household (`GET /api/households/:id`) shows everyone who can see it the household's pending invites: who is invited, as what, by whom and until when, but never the invitee's address or message (#297). Listing the household's invites, past ones included, is a household owner's or admin's, and their list adds each invitee's address (#167).
- **The last owner** can't leave or be removed until they transfer ownership.
- **Event roles** (host, co-host and the rest) are separate from household roles, and someone who creates a household event hosts it. Household owners and admins edit and cancel the household's events and their occurrences, but deleting an event is its host's (#567), and deleting an occurrence belongs to the event's own roles.
- **Restoring a deleted household** is open to any of its owners during the restore window. The deletion grants it, one household at a time, rather than a household role (#175).
- **Plays** have no routes yet (#478), so their rows say what the household roles will hold once they do.
- **Every household role is one of these four.** A household never writes roles of its own. It will add permissions through a variant of a shipped household role (#844), and take them away per household (#845); either way the member keeps one of these four. Until either ships, a client may read this table by role name. After that the role name no longer says everything a member may do, and the API owes the client a field saying what the viewer may do (#844, #845). `docs/adr/0001-households-never-write-roles.md` records why (#169).

## How a household role is set

Each change to someone's household role has one path, and no other server code sets one (#169). The e2e fixtures write role rows directly, to arrange a household before any request is sent. Removing a member, or leaving, deletes the role along with the membership. A new path, such as a ban or guardianship, is added here when it is designed.

| Change                                                                                              | The only path                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A founder becomes household owner                                                                   | Creating the household (`HouseholdService.create`)                                                                                                                                                                                                                                             |
| A newcomer gets the household admin, member or guest role                                           | Accepting an invite. The role the invite offers is checked when it's sent (`CreateHouseholdInviteDto`) and when it's accepted (`PartyInviteService`), and written by `HouseholdMemberService.addMemberWithin`, which refuses the household owner role and returns an existing member unchanged |
| An existing member moves between the household admin, member and guest roles                        | `PATCH /api/households/:householdId/members/:memberId/role` (`HouseholdMemberService.updateMemberRole`)                                                                                                                                                                                        |
| An existing member becomes household owner, and the owner who hands it over becomes household admin | Transferring ownership (`POST …/members/:memberId/transfer-ownership`), and nothing else (#158)                                                                                                                                                                                                |
| A join request is approved (#231, not built yet)                                                    | Will go through `addMemberWithin`                                                                                                                                                                                                                                                              |

The invite and the role change share one rule for which roles can be given: `ASSIGNABLE_HOUSEHOLD_ROLES` and `isAssignableHouseholdRole`, beside `UpdateMemberRoleDto`. Every path but creating the household looks the role up through `resolveHouseholdRoleId`; creating the household connects the household owner role by name.

## Running unit tests

Run `npm run nx -- test @board-games-empire/household` to execute the unit tests via [Jest](https://jestjs.io).
