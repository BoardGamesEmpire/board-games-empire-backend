# Proposed ordering

## Phase 0 — preparatory (weeks, in parallel with current work)

1. #57 Phase 1 (audit log groundwork: Actor discriminated union, CLS migration, event meta). Touches everything; cheapest when done early; unblocks correct actor modeling for everything that follows. - partially complete
2. #72 OpenTelemetry in core. Same logic — retrofit pain is real, observability you don't have when you need it is worse. - complete in #82 with prisma metrics deferred [#81](https://github.com/BoardGamesEmpire/board-games-empire-backend/issues/81)

These two can land alongside whatever else is in flight; they're cross-cutting prep, not standalone features.

## Phase 1 — foundations with immediate user value

3. #55 SafeHttpService. Tiny, blocks #56. Completed in #83.
4. #56 Webhook subscriptions. Standalone primitive, immediately useful, exercises SafeHttpService end-to-end.
5. #69 Quota primitive. Lands before storage so quota checks are in MediaObject create from day one (retrofit pain).
6. #58 MediaObject + StorageDriver + LocalDiskDriver. Foundation; usable without plugin loader.
7. #68 AbilityService. Lands with user/apiKey/system dispatch; plugin dispatch added later. Existing services start migrating opportunistically.
8. #57 Phase 2 (audit log table + listener). Now that Phase 1 prep is everywhere, the listener has substrate to work against.
9. Phase 2 — feedback module completes. Feedback module (in progress) — finish, defining FeedbackSink interface inline. Local sink ships as the bundled implementation.
10. #70 FeedbackSink — formalize the interface that already exists from step 9. Mostly documentation + the eventual plugin-category wiring.

## Phase 3 — plugin loader (extraction, not invention)

11. #62 Streaming + tus. Doesn't depend on plugins; can slot earlier if media uploads are user-pressing.
12. #59 Plugin loader. Extracts what now exists in three concrete shapes: gateways (#59 retrofits them), storage drivers, feedback sinks. Each becomes bundled: true plugin rows; the loader generalizes lifecycle.
13. #60 Permission risk + selective grants. Tightly coupled to #59; lands immediately after.
14. #68 plugin dispatch — add the plugin actor kind to AbilityService now that PluginAbilityFactory exists.

## Phase 4 — first non-bundled plugin

15. #61 S3 storage driver plugin. Dogfood. Validates the abstraction with one real out-of-tree consumer. Expect this to surface design flaws in #59; fix them here before the next plugin.

## Phase 5 — second wave plugins

16. #66 NotificationChannel + Discord plugin. Higher value than further infrastructure work; reactive plugin pattern, simpler than media integrations.
17. #67 Plugin activity dashboard. Now that two non-trivial plugins exist, observability of their behavior earns its keep.
18. #74 CalendarSync category + first provider plugin. High user value once events are mature.

## Phase 6 — media integrations

19. #64 MediaReference + MediaIntegrationDriver.
20. #65 Paperless plugin (or Immich, whichever comes first).

## Phase 7 — observability layer & remaining infrastructure

21. #73 Sentry plugin. Layered on OTel; lower priority since OTel already gives most teams what they need.
22. #63 Storage migration service. Defer until a real user actually wants to migrate from local-disk to S3.
23. #71 BackupSink + bundled local backup. Critical for production self-hosters, but most early users can lean on Postgres dumps + filesystem backup of the storage dir until then.

## Phase 8 — speculative / opportunistic

24. #75 RecommendationEngine. Genuinely cool, no urgent demand; ships when you want it.
25. Client #19 SDUI. Don't start until you have a backend plugin needing UI extension AND the BGE widget library has shape. Likely Phase 5+ on the client side.
