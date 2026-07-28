# Gateway & Plugin Architecture Roadmap

Tracking doc for epic [#192](https://github.com/BoardGamesEmpire/board-games-empire-backend/issues/192) — port/adapter hybrid, plugin loader, scoped consent, registry channels. Full decision log (D1–D16) lives in the epic body; the dated review decisions live as amendment comments pending manual fold-in: 2026-07-22 (D-A–D-I, durable denial, loader↔distribution boundary, marketplace deferral), 2026-07-23 (Phase A audit D-J–D-M, Phase B D-N–D-P), 2026-07-24 (D-Q–D-T), 2026-07-26 (D-U ability context, D-V delegation model, `bgeVersion` codegen notes), 2026-07-27 (Phase C: D-W permission grammar, D-X `decidedRiskLevel`, D-Y installer boundary, D-Z endpoints + admin slugs, D-AA grant semantics), 2026-07-28 (C2 pre-generation: D-AB step-13 timing, D-AC static-analysis scope + deep-scan, D-AD authority-check mechanics, D-AE second-factor seam, D-AF `PluginPermission` diff ownership + fresh-consent uninstall, D-AG typed provenance, plus the uninstall-vs-unit-config open item for C4) — all on #59; publisher-identity deferral on #84; delete-to-pending revocation on #211; triad-restructure scope expansion on #216.

**Current focus: → #216 lib restructure, then #59 Phase C2** _(C1 merged 2026-07-28, PR #215; #212 closed as delivered by PR #214. #216 restructures `libs/plugin` to the contract / contract-testing / runtime triad — matching storage and gateway-driver — before C2 grows the lib, so the installer is built into the final layout.)_

## Recommended order

Check items off as PRs merge. Ordering rationale in the notes column; parallelizable work is marked.

### Wave 1 — foundation (strictly ordered)

- [x] **#193 — GameGatewayDriver port + registry + RemoteGatewayDriver** _(delivered by PR #203, 2026-07-22 — PR wasn't linked, closed manually)_
      First deliberately: zero external behavior change, small blast radius, and it produced the registry that #59's `DataGateway` category extends (and that `BasePluginRegistry` generalizes). Coordinator untouched externally (Phase 0).
- [ ] **#60 — Permission risk classification + selective grants** _(the `riskLevel` slice — enum, migration, explicit classification of all 123 seeded permissions with compile-time enforcement — MERGED 2026-07-27 alongside #212; remaining scope: `PluginAbilityFactory` [unblocked by #59 C1, still needs #68's `resolveForActor` dispatch], install-response risk enrichment, feature-state surface)_
- [ ] **#216 — libs/plugin triad restructure** _(scope expanded 2026-07-28: contract / contract-testing / runtime, matching the storage and gateway-driver precedents; `libs/plugin/plugin` renames to `runtime`, the registry contract suite moves to `@boardgamesempire/plugin-contract-testing`, framework-free surfaces [registry base, `PluginContext` types + factory signature, `InstalledPluginDirectory`, event vocabulary] move to `@boardgamesempire/plugin-contract`, and both #215 stopgaps are reverted. Precedes C2.)_
- [ ] **#59 — Plugin loader** _(decision log: D-A–D-I 2026-07-22; D-J–D-P 2026-07-23; D-Q–D-T 2026-07-24; D-U/D-V 2026-07-26; D-W–D-AA 2026-07-27; D-AB–D-AG 2026-07-28 — see issue comments)_
      Lands as phased PRs per decision D-I:
      **Phase A ✓ (merged)** — data model + validation, no runtime: `Plugin`/`HouseholdPlugin`/`PluginGrant`/`PluginLifecycleEvent` schema, `@boardgamesempire/plugin-manifest` (zod source of truth → generated JSON Schema artifact, collect-all semantic validator, localization resolution), `@bge/plugin` (`BasePluginRegistry` + contract suite, lifecycle event classes riding the #57 audit pipeline). Audit patch (D-J–D-M) delivered by PR #207.
      **Phase B ✓ (merged, PR #208)** — runtime: loader boot path (quarantine-and-continue per D-Q), CLS plugin actor (`PluginActorScope`), `PluginContext` factory contract (D-B; entrypoint resolution per D-N), lifecycle listener → `plugin_lifecycle_events` (post-commit, D-P; `onAny` dispatch), config pub/sub hot-reload (D-S), bundled in-tree resolution branch without seeds (D-O). Audited 2026-07-26: all deliverables verified; deviations spun out as #212 (module wiring — merged in PR #214, issue closed) and #213 (discovery-cache invalidation — deferred until a discovery-contributing surface exists). Host wiring: `bgeVersion` is a build-time codegen constant (`generate` Nx target, gitignored output), not an env var.
      **Phase C — install/update consent, four PRs:**
      **C1 ✓ (merged, PR #215)** — `PluginPermission` catalog + D-W grammar (bare author slugs, generated `plugin|<slug>|<bare>` envelope via the shared `expandPluginPermissionSlug` helper), `PluginGrant.decidedRiskLevel` (D-X), `PluginGrantService` (grant-time authority checks per D-AA, `manage:plugin*` hard exclusion + wildcard-subject block per D-Z applied on both core and plugin-origin routes, delete-to-pending revocation per #211 with Granted-only filtering preserving durable denials, `plugin.grant_revoked` lifecycle event). Review-hardened: atomic upsert on the unique quadruple, manifest slug/version drift refusal, `enforceBgeCompat` opt-out so consent stays recordable past a plugin's compat range, idempotent re-statement rule. Side discovery: the contract-suite-in-runtime-barrel boot crash → stopgapped in #215, structural fix is #216.
      **C2 (next, after #216)** — install pipeline steps + `PluginInstallerService` (consent/DB half per D-Y: manifest re-validation, step-3 DB half + declares collision, static analysis via `es-module-lexer` + `meriyah` [D-E] with the D-AC scan scope + forbidden-specifier constant + optional advisory deep-scan mode, installer authority check per D-AD [server-admin at the service seam; `manage:plugin` guard arrives with C4], Critical second factor on the service input per D-AE [`confirmCriticalSlugs`], transactional persist + `PluginPermission` seeding [fresh install only per D-AF] + server-scope grant seeding); provenance is the D-AG discriminated union so `bundled ⇒ sha256` (invariant 2) is compile-time. Step 13 (denial-list check) moved out of fresh install per D-AB. The `scope_id` CHECK constraint (invariant 1) already landed with the Phase A fix (`81ae215`). New deps `es-module-lexer` / `meriyah` verified against the jest ESM allowlist before specs.
      **C3** — update-escalation comparison (risk escalation detectable via `decidedRiskLevel`; surviving server-scope `Denied` row on a permission promoted to required blocks activation per D-AB), pending staging, per-unit disable/re-enable, `declares[]` catalog diff on activation swap (insert added / delete removed `PluginPermission` rows; grants on removed declares deleted with `'permission-removed'` revocation provenance per D-AF).
      **C4** — consent-collection endpoints (household enable/disable/config, grant decide, update approve/reject, server enable/disable/uninstall — ingress endpoints stay with #84) + admin permission seeds (`manage:plugin` Critical, `read:plugin` Medium, `manage:plugin:household` Medium, `read:plugin:household` Low). Open decision to lock first: uninstall vs. downstream unit config (2026-07-28 amendment — recommendation is the tombstone model: grants purged / fresh consent, unit config preserved by default, explicit `purgeData` flag, unit notification, reinstall reattaches).
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

- [ ] **#211 — Eager grant revocation on authority loss** _(opened 2026-07-26; deps: #59 C1 ✓ — the revocation write path and `plugin.grant_revoked` event landed in PR #215; this issue owns the authority-change listeners. Semantics locked 2026-07-27: delete-to-pending, D-AA)_
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
      │    ▲
      │  #216 (triad restructure, precedes C2)
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
- 2026-07 amendments to #59/#84/#211/#216 live as dated issue comments (API body edits mangle code fences); latest: 2026-07-28 C2 pre-generation decisions (D-AB–D-AG) on #59 and the triad-restructure expansion on #216. Fold into the bodies on next manual edit. #60's body IS current (rewritten 2026-07-22; later status flags are comments).
