# Gateway & Plugin Architecture Roadmap

Tracking doc for epic [#192](https://github.com/BoardGamesEmpire/board-games-empire-backend/issues/192) — port/adapter hybrid, plugin loader, scoped consent, registry channels. Full decision log (D1–D16) lives in the epic body; the dated review decisions live as amendment comments pending manual fold-in: 2026-07-22 (D-A–D-I, durable denial, loader↔distribution boundary, marketplace deferral), 2026-07-23 (Phase A audit D-J–D-M, Phase B D-N–D-P), 2026-07-24 (D-Q–D-T), 2026-07-26 (D-U ability context, D-V delegation model, `bgeVersion` codegen notes), 2026-07-27 (Phase C: D-W permission grammar, D-X `decidedRiskLevel`, D-Y installer boundary, D-Z endpoints + admin slugs, D-AA grant semantics) — all on #59; publisher-identity deferral on #84; delete-to-pending revocation on #211.

**Current focus: → #59 Phase C** _(Phases A & B merged and audited; #60's `riskLevel` slice + #212 module wiring merged 2026-07-27 — no external blockers remain. Phase C lands as four PRs, C1 first.)_

## Recommended order

Check items off as PRs merge. Ordering rationale in the notes column; parallelizable work is marked.

### Wave 1 — foundation (strictly ordered)

- [x] **#193 — GameGatewayDriver port + registry + RemoteGatewayDriver** _(delivered by PR #203, 2026-07-22 — PR wasn't linked, closed manually)_
      First deliberately: zero external behavior change, small blast radius, and it produced the registry that #59's `DataGateway` category extends (and that `BasePluginRegistry` generalizes). Coordinator untouched externally (Phase 0).
- [ ] **#60 — Permission risk classification + selective grants** _(the `riskLevel` slice — enum, migration, explicit classification of all 123 seeded permissions with compile-time enforcement — MERGED 2026-07-27 alongside #212, unblocking #59 Phase C; remaining scope: `PluginAbilityFactory` [needs #59 C1 + #68's `resolveForActor` dispatch], install-response risk enrichment, feature-state surface)_
- [ ] **#59 — Plugin loader** _(decision log: D-A–D-I 2026-07-22; D-J–D-P 2026-07-23; D-Q–D-T 2026-07-24; D-U/D-V 2026-07-26; D-W–D-AA 2026-07-27 — see issue comments)_
      Lands as phased PRs per decision D-I:
      **Phase A ✓ (merged)** — data model + validation, no runtime: `Plugin`/`HouseholdPlugin`/`PluginGrant`/`PluginLifecycleEvent` schema, `@boardgamesempire/plugin-manifest` (zod source of truth → generated JSON Schema artifact, collect-all semantic validator, localization resolution), `@bge/plugin` (`BasePluginRegistry` + contract suite, lifecycle event classes riding the #57 audit pipeline). Audit patch (D-J–D-M) delivered by PR #207.
      **Phase B ✓ (merged, PR #208)** — runtime: loader boot path (quarantine-and-continue per D-Q), CLS plugin actor (`PluginActorScope`), `PluginContext` factory contract (D-B; entrypoint resolution per D-N), lifecycle listener → `plugin_lifecycle_events` (post-commit, D-P; `onAny` dispatch), config pub/sub hot-reload (D-S), bundled in-tree resolution branch without seeds (D-O). Audited 2026-07-26: all deliverables verified; deviations spun out as #212 (module wiring — since merged) and #213 (discovery-cache invalidation — deferred until a discovery-contributing surface exists). Host wiring: `bgeVersion` is a build-time codegen constant (`generate` Nx target, gitignored output), not an env var.
      **Phase C (current)** — install/update consent, four PRs:
      **C1 (in progress)** — `PluginPermission` catalog + D-W grammar (bare author slugs, generated `plugin|<slug>|<bare>` envelope via the shared `expandPluginPermissionSlug` helper), `PluginGrant.decidedRiskLevel` (D-X), `PluginGrantService` (grant-time authority checks per D-AA, `manage:plugin*` hard exclusion + wildcard-subject block per D-Z, delete-to-pending revocation write path per #211, `plugin.grant_revoked` lifecycle event).
      **C2** — install pipeline steps + `PluginInstallerService` (consent/DB half per D-Y: manifest re-validation, step-3 DB half + declares collision, static analysis via `es-module-lexer` + `meriyah` [D-E], installer authority, denial list, Critical second factor, transactional persist + grant seeding); `bundled ⇒ sha256` invariant enforced at this seam. The `scope_id` CHECK constraint (invariant 1) already landed with the Phase A fix (`81ae215`).
      **C3** — update-escalation comparison (risk escalation detectable via `decidedRiskLevel`), pending staging, per-unit disable/re-enable.
      **C4** — consent-collection endpoints (household enable/disable/config, grant decide, update approve/reject, server enable/disable/uninstall — ingress endpoints stay with #84) + admin permission seeds (`manage:plugin` Critical, `read:plugin` Medium, `manage:plugin:household` Medium, `read:plugin:household` Low).
- [ ] **#84 — Plugin distribution** _(amended 2026-07-22: `PluginRegistrySource` model + `PluginRegistryClient` interface defined; multi-registry implementation deferred post-alpha — alpha ships the single seeded, non-deletable `bge-official` source. Amended 2026-07-27: publisher-scoped plugin identity deferred here from the #59 Phase C pass — the D-W envelope inherits any future publisher-scoped slug grammar through the single expansion helper.)_
      Implements the distribution-owned pipeline steps against #59's contracts (ingress, SHA-256, extraction, npm audit, atomic move) and wraps C2's `PluginInstallerService` per D-Y. Independently landable after #59 Phase A. Registry repo (`bge-plugin-registry`) scaffolding included.

### Wave 2 — gateways become plugins (ordered after wave 1)

- [ ] **#194 — BGG & IGDB → official non-bundled DataGateway plugins**
      Needs #59 + #84 + #193. Normalization-parity specs are the regression gate.
- [ ] **#195 — First-run data-source setup + zero-gateway empty state**
      Needs #194 published entries to be a complete flow, but the empty-state/backend surface can start now that #193 is merged.

### Wave 3 — parallel tracks (any order, after their deps)

- [ ] **#196 — Inbound topics + feeds** _(deps: #59, #193; #27 for remote push)_
- [ ] **#197 — Worker-thread execution mode, tier 2** _(deps: #59, #193 — satisfies the D-B `PluginContext` contract over RPC shims)_
- [ ] **#198 — Admin announcements** _(deps: #66 bridge; independent of gateway work)_
- [ ] **#199 — Scheduled updates + pre-consent windows** _(deps: #198, #59, #84 — last of the consent stack)_
- [ ] **#200 — Single image + BGE_ROLES packaging** _(deps: #193 only; can land any time)_

### Backlog / design track

- [ ] **#211 — Eager grant revocation on authority loss** _(opened 2026-07-26; deps: #59 C1 — the revocation write path and `plugin.grant_revoked` event land there; this issue owns the authority-change listeners. Semantics locked 2026-07-27: delete-to-pending, D-AA)_
- [ ] **#213 — Plugin lifecycle → discovery-cache invalidation** _(opened 2026-07-26; deferred from Phase B until a discovery-contributing plugin surface exists — #78/#76 consumers via #194/#61)_
- [ ] **#204 — Plugin-owned table DDL & migration strategy** _(opened 2026-07-22; deps: #59, #84)_
      Activates the D-H-inert `storage.ownTables` declaration. Leading candidate: host-executed declarative SQL migrations from the tarball (Flyway-style, per-plugin schema or `plugin_<slug>_` prefix), with the host KV store as the zero-ceremony default. Decision to be locked before implementation.
- [ ] **#206 — Publish plugin-manifest JSON Schema artifact at its `$id` URL** _(opened 2026-07-23; deps: #59 Phase A patch (emit target), #84 release pipeline)_
      The `emit-json-schema` Nx target produces the file; #206 owns hosting + the v1-immutability policy.
- [ ] **#201 — Shared/community gateway** _(hosted-dependent; BGG ranks-dump seeding, IGDB webhook-warmed cache)_
- [ ] **#61 — StorageDriver plugin-category retrofit** _(deferred out of #59 by decision D-G: local-disk `Plugin` row pre-seed + registry contract adoption)_
- [ ] Coordinator Phase 2 decision (optional `BGE_ROLES` role) — deliberately unscheduled, see #193

## Dependency sketch

```
#193 ─┬─▶ #59 ◀── #60          #198 ─▶ #199 ◀─ (#59, #84)
      │    │
      │    ├─▶ #84 ─▶ #194 ─▶ #195
      │    ├─▶ #196
      │    ├─▶ #197
      │    ├─▶ #211 (C1-dependent listeners)
      │    ├─▶ #213 ◀─ (#194/#61 discovery surfaces)
      │    ├─▶ #204 ◀─ #84     #61 (backlog: #59, #100/#101)
      │    └─▶ #206 ◀─ #84
      └─▶ #200        #201 (backlog: #193, #194, #196)
```

## Status legend

- Unchecked = not started · strike-through title = descoped · add `(in PR #___)` inline when work is up for review
- 2026-07 amendments to #59/#84/#211 live as dated issue comments (API body edits mangle code fences); latest: 2026-07-27 Phase C decisions (D-W–D-AA) on #59. Fold into the bodies on next manual edit. #60's body IS current (rewritten 2026-07-22; later status flags are comments).
