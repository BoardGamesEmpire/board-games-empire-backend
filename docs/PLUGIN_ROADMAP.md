# Gateway & Plugin Architecture Roadmap

Tracking doc for epic [#192](https://github.com/BoardGamesEmpire/board-games-empire-backend/issues/192) — port/adapter hybrid, plugin loader, scoped consent, registry channels. Full decision log (D1–D16) lives in the epic body.

**Current focus: → #193**

## Recommended order

Check items off as PRs merge. Ordering rationale in the notes column; parallelizable work is marked.

### Wave 1 — foundation (strictly ordered)

- [ ] **#193 — GameGatewayDriver port + registry + RemoteGatewayDriver**
      First deliberately: zero external behavior change, small blast radius, and it produces the registry that #59's `DataGateway` category extends. Coordinator untouched externally (Phase 0).
- [ ] **#60 — Permission risk classification + selective grants**
      Soft prerequisite of #59: install validation steps reference the admin denial list and `riskLevel` escalation gates. Land before or alongside #59.
- [ ] **#59 — Plugin loader** _(amended: PluginGrant, consent units, executionMode, topics field)_
      The big one. Lands after #193 so the DataGateway retrofit targets the split registry instead of the monolithic `GatewayRegistryService`.
- [ ] **#84 — Plugin distribution** _(amended: registry manifest, channels, channel floors)_
      Pairs with #59; the loader consumes what distribution populates. Registry repo (`bge-plugin-registry`) scaffolding included.

### Wave 2 — gateways become plugins (ordered after wave 1)

- [ ] **#194 — BGG & IGDB → official non-bundled DataGateway plugins**
      Needs #59 + #84 + #193. Normalization-parity specs are the regression gate.
- [ ] **#195 — First-run data-source setup + zero-gateway empty state**
      Needs #194 published entries to be a complete flow, but the empty-state/backend surface can start once #193 merges.

### Wave 3 — parallel tracks (any order, after their deps)

- [ ] **#196 — Inbound topics + feeds** _(deps: #59, #193; #27 for remote push)_
- [ ] **#197 — Worker-thread execution mode, tier 2** _(deps: #59, #193)_
- [ ] **#198 — Admin announcements** _(deps: #66 bridge; independent of gateway work)_
- [ ] **#199 — Scheduled updates + pre-consent windows** _(deps: #198, #59, #84 — last of the consent stack)_
- [ ] **#200 — Single image + BGE_ROLES packaging** _(deps: #193 only; can land any time after it)_

### Backlog / design track

- [ ] **#201 — Shared/community gateway** _(hosted-dependent; BGG ranks-dump seeding, IGDB webhook-warmed cache)_
- [ ] Coordinator Phase 2 decision (optional `BGE_ROLES` role) — deliberately unscheduled, see #193

## Dependency sketch

```
#193 ─┬─▶ #59 ◀── #60          #198 ─▶ #199 ◀─ (#59, #84)
      │    │
      │    ├─▶ #84 ─▶ #194 ─▶ #195
      │    ├─▶ #196
      │    └─▶ #197
      └─▶ #200        #201 (backlog: #193, #194, #196)
```

## Status legend

- Unchecked = not started · strike-through title = descoped · add `(in PR #___)` inline when work is up for review
- Amendments to #59/#84 are already reflected in their issue bodies; no separate amendment work item exists.
