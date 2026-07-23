# Gateway & Plugin Architecture Roadmap

Tracking doc for epic [#192](https://github.com/BoardGamesEmpire/board-games-empire-backend/issues/192) — port/adapter hybrid, plugin loader, scoped consent, registry channels. Full decision log (D1–D16) lives in the epic body; the 2026-07-22 review decisions (D-A–D-I, durable denial, loader↔distribution boundary, marketplace deferral) live as amendment comments on #59/#84 pending manual fold-in.

**Current focus: → #59 Phase A** _(#60's `riskLevel` schema+seed slice is parallelizable — see wave 1 note)_

## Recommended order

Check items off as PRs merge. Ordering rationale in the notes column; parallelizable work is marked.

### Wave 1 — foundation (strictly ordered)

- [x] **#193 — GameGatewayDriver port + registry + RemoteGatewayDriver** _(delivered by PR #203, 2026-07-22 — PR wasn't linked, closed manually)_
      First deliberately: zero external behavior change, small blast radius, and it produced the registry that #59's `DataGateway` category extends (and that `BasePluginRegistry` generalizes). Coordinator untouched externally (Phase 0).
- [ ] **#60 — Permission risk classification + selective grants** _(reconciled 2026-07-22: denial storage superseded by #59's `PluginGrant` status model)_
      The `riskLevel` enum + seed slice is tiny and landable **ahead of #59 Phase A** (unblocks install-validation steps 13–14). `PluginAbilityFactory`, install-response enrichment, and feature-state land after #59 Phases A–B.
- [ ] **#59 — Plugin loader** _(amended 2026-07-22: locked decisions D-A–D-I, `PluginGrant` durable denial, pipeline interfaces — see issue comment)_
      Lands as ≥3 PRs per decision D-I:
      **Phase A** — data model + validation, no runtime: `Plugin`/`HouseholdPlugin`/`PluginGrant`/`PluginLifecycleEvent` schema, `@boardgamesempire/plugin-manifest` (zod source of truth → generated JSON Schema artifact, collect-all semantic validator, localization resolution), `@bge/plugin` (`BasePluginRegistry` + contract suite, lifecycle event classes riding the #57 audit pipeline).
      **Phase B** — runtime: loader boot path, CLS plugin actor, `PluginContext` factory contract (D-B), lifecycle listener → `plugin_lifecycle_events` + discovery-cache invalidation, config pub/sub reload.
      **Phase C** — install/update consent: pipeline steps owned here (manifest validation, static analysis via es-module-lexer + meriyah, installer authority, grant seeding), escalation comparison, pending staging, per-unit disable/re-enable. Coordinates with #60's `PluginAbilityFactory`.
- [ ] **#84 — Plugin distribution** _(amended 2026-07-22: `PluginRegistrySource` model + `PluginRegistryClient` interface defined; multi-registry implementation deferred post-alpha — alpha ships the single seeded, non-deletable `bge-official` source)_
      Implements the distribution-owned pipeline steps against #59's `PluginInstallPipelineStep` contracts (ingress, SHA-256, extraction, npm audit, atomic move). Independently landable after #59 Phase A. Registry repo (`bge-plugin-registry`) scaffolding included.

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

- [ ] **#204 — Plugin-owned table DDL & migration strategy** _(opened 2026-07-22; deps: #59, #84)_
      Activates the D-H-inert `storage.ownTables` declaration. Leading candidate: host-executed declarative SQL migrations from the tarball (Flyway-style, per-plugin schema or `plugin_<slug>_` prefix), with the host KV store as the zero-ceremony default. Decision to be locked before implementation.
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
      │    └─▶ #204 ◀─ #84     #61 (backlog: #59, #100/#101)
      └─▶ #200        #201 (backlog: #193, #194, #196)
```

## Status legend

- Unchecked = not started · strike-through title = descoped · add `(in PR #___)` inline when work is up for review
- 2026-07 amendments to #59/#84 live as dated issue comments (API body edits mangle code fences); fold into the bodies on next manual edit. #60's body IS current (rewritten 2026-07-22).
