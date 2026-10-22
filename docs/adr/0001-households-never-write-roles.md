# Households customize their roles without writing roles

A household never writes `Role` rows. Every household role is one of the four the permission catalog ships: household owner, household admin, member role and household guest. Much of the permission model decides by those names: who may act on the household admin role (#168), who answers for a household's invites (#167), who governs a household and who may hand ownership on (#158). A household that wants its roles to differ does so in two ways, and both leave the member holding a shipped role (#169):

- **Adding permissions** is done by a household role variant: a household-named set of extra permissions on top of the household admin, member or guest role (#844). A variant only adds, and only household activity, such as events, plays and quota reads. It never adds governance: invites, the roster, editing or deleting the household, membership quotas, administering the household's plugins, or ownership. Most of those name a role inside their condition, so on a member or guest base they would grant nothing anyway. The permissions for membership quotas and plugin administration name none and would work on any base, so they stay out because they are governance, not because of their conditions. Who governs a household stays with the shipped roles. A variant never adds a denial either. The household pass runs after the server roles pass, so a denial there could take away what the base role User grants, which no household role may do.
- **Taking permissions away** is a separate mechanism, built per household (#845). It drops a household role's own permissions before they're rendered, and never adds a denial, for the same reason.

`Role` rows come only from the permission catalog, and from server admins as custom roles if #772 allows them.

## Considered options

- **Household-written `Role` rows.** The most general answer, rejected because every condition that names a role would need rewriting, and the four role names carry the household admin split and ownership changes. `Role.name` is also unique server-wide, so a household's role would need a fourth `managedBy` owner, and a household-scoped role would make #429's gap live.
- **A household join table of role names and per-person direct permissions (`UserPermission` rows).** Rejected because a role would be copied onto each holder, so every edit rewrites every holder's rows and evicts every holder's cached permissions. Direct permissions are rendered with only the user known, so a condition bound to the household matches nothing. And direct permissions are the server admin's per-person layer, applied last, where a denial wins.
- **No customization.** Needs nothing built, and household settings such as the member invite policy (#166) already cover graded choices. Rejected because a setting changes a role for everyone who holds it, and can't single out one member.

## Consequences

- #844 decides whether the activity-only rule is computed from the permission catalog or kept as an explicit list. A computed rule can't stop at whether a condition names a role, since the permissions for membership quotas and plugin administration name none.
- A server admin editing a shipped role (#772), or a household restricting one (#845), can leave a role holding one of a pair of permissions the shipped roles always hold together, such as approving an invite without revoking one. Each permission must stand on its own.
