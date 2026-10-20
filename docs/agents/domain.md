# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`GLOSSARY.md`** at the repo root. It runs to about 55 KB, so grep it for the domain nouns in play rather than reading it whole.
- **`docs/adr/`**: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## Where a decision goes

- **ADR** (`docs/adr/`): a project-wide decision that outlives any one issue, such as a transport, a permission model or a layering rule.
- **Issue amendment**: a decision about one issue's design. Post it as a dated amendment comment on that issue (see `docs/agents/issue-tracker.md`).

When an issue-level decision turns out to bind future work, record it as an ADR and link the issue from it.

## File structure

This is a single-context repo: one glossary and one ADR folder cover every app and lib.

```text
/
├── GLOSSARY.md
├── docs/adr/
│   ├── 0001-<decision>.md
│   └── 0002-<decision>.md
├── apps/
└── libs/
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name, a comment, an error string, a commit message), use the term as defined in `GLOSSARY.md`. Each entry's `_Avoid_:` line lists the synonyms to leave out; reviews hold new prose to it.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
