# Plugin consent is worked out when read

A plugin acts only with the authority consented to it. Who gives that consent, and what the server does when a plugin asks for more, used to be tracked as stored state on each household's and user's plugin row: a "suspended for consent" flag and a dormancy reason, rewritten by every path that touched a grant, a manifest or a catalog risk, under a pinned lock order. Every gap between those writers was a bug (#1061, #1063, #1147), four read-side rules disagreed about what "consented" meant, and a unit still answering its first required permissions was served while one that owed re-consent after an update was stopped. The decision was made in the plugin consent redesign (#1154; the decisions recorded on #583 on 2026-11-07).

- **Three gates, each owned by one party, and no gate implies another.** The operator installs a plugin, which accepts its server-scope permissions, and controls the server switch and the outbound policy. A household switches a plugin on by accepting its full required set in one act, with optional permissions as toggles it can change any time. A user does the same at user scope. Refusing any required permission, at switch-on or at a later review, rejects the plugin for that unit. Installing never counts as a household's acceptance, even for a household the installing admin belongs to.
- **Acceptance belongs to the unit.** It was made by whoever held authority at the time and survives them. The server never deletes consent because membership changed.
- **The server never stops a household's or user's plugin on its own.** While an update is staged, affected units are told and may accept against the staged manifest. After activation a unit that has not answered keeps running on exactly the grants it gave: the ability denies what it has not granted, feature state says what is waiting, and a notification asks for review. Running degraded is never worse than being stopped on privacy and is better on continuity.
- **Everything derived is worked out when read.** Whether a plugin is served for a unit follows from the switches, the manifest's surface at that scope and whether the retained configuration conforms. What the unit still owes, its consent standing, follows from its grants, the active manifest and today's catalog risk. Five unit states, each a stable code: `off`, `on`, `review_pending`, `needs_configuration`, `unavailable`. One implementation answers the ability check, feature state, the consent surface and the inventory. No column stores any of it.
- **A consent act records what was shown.** Each act is an append-only record naming the manifest's artifact sha and holding the presentation verbatim. Per-permission grant rows remain the current state and point at the act that last set them. Grants are never revoked by a manifest change; a grant outside the active manifest confers nothing, and a rollback is covered by the acceptance already given.
- **Concurrency is optimistic.** An act is refused when the plugin's artifact sha is no longer the one it was shown. Nothing else needs a lock order.
- **The timeline records causes**, never a stored state.

## Considered options

- **Keep the stored flag and fix the sync gaps** with a shared suspend/lift module and one outstanding rule. Small and half-planned, but it keeps twelve writers, and every future manifest-replacing path (rollback, several registries, scheduled update checks) must remember to call the module or become the next #1061. Rejected.
- **Assume acceptance of new permissions on the operator's authority**, since the operator already gates which plugins exist. Smoothest update, but a household's data would be granted on its behalf, against the privacy priority. Rejected; the operator's levers stay install, uninstall, the server switch and the outbound policy.
- **Stop a unit whose required consent is incomplete** until it answers. Equal to degraded on privacy and strictly worse on continuity (a backup plugin stops backing up). Rejected.
- **A per-permission ceiling set by the operator** on what households may enable. A third state for every optional permission, more copy and another input to the one rule. Rejected for now; additive later as its own issue.
- **Fully immutable grant records, latest wins.** Records what was shown by construction, but makes the per-permission state a windowed query on every ability read and turns an optional toggle into re-stating the whole set. Rejected in favour of an append-only act beside the per-permission rows.

## Consequences

- Two kinds of "not consented" become one: pending required consent means `review_pending` whether it is the first time or after an update.
- `suspendedForConsent`, `suspendedAt`, `dormantReason` and `dormantAt` are dropped, with every pass that wrote them, the per-unit advisory keys, the unit-row locks, the deadlock retry and the static lock audit.
- The client renders five states and one switch-on-and-consent screen (client#801). Responses carry `state` and `consent` instead of the dropped columns.
- A catalog risk change has no writer: a raise shows as review pending, a fall covers again.
- Reinstall starts every unit switched off; the household switches on again and sees the required set afresh. One version per slug: a beta is a separate slug.
- The serving check reads the unit's grants, the manifest and the risk of the slugs it names on every resolution. A cache keyed on (artifact sha, latest act, catalog version) is the remedy if that cost is measured, not assumed.
- Guardianship later is an authority rule over who may act for a unit; the act already records the unit and the decider separately.
